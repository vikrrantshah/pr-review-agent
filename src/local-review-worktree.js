import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAddedLines } from './github-adapter.js';
import { runProcess } from './process-runner.js';

export class LocalReviewWorktree {
  constructor({ run = runProcess, rootDir = join(tmpdir(), 'pr-review-agent-worktrees'), id = randomUUID, logger = console } = {}) {
    this.run = run;
    this.rootDir = rootDir;
    this.id = id;
    this.logger = logger;
  }

  async withCheckout(request, callback) {
    const safeRepo = request.repository.nameWithOwner.replace(/[^a-zA-Z0-9.-]+/g, '-');
    const dir = join(this.rootDir, `${safeRepo}-${request.number}-${this.id()}`);
    const repoDir = join(dir, 'repo');
    const worktreeDir = join(dir, 'worktree');
    const branch = `pr-${request.number}`;
    const base = request.baseRefName;
    const remote = `https://github.com/${request.repository.nameWithOwner}.git`;
    if (!base) {
      throw new Error(`baseRefName is required for ${request.repository.nameWithOwner}#${request.number}`);
    }
    let failed = false;

    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await this.run('git', ['init', repoDir], undefined);
      await this.run('git', ['remote', 'add', 'origin', remote], undefined, { cwd: repoDir });
      const authEnv = await gitAuthEnv(this.run, dir);
      await this.run('git', ['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`, `+refs/pull/${request.number}/head:refs/heads/${branch}`], undefined, { cwd: repoDir, env: authEnv });
      await this.run('git', ['worktree', 'add', '--detach', worktreeDir, `refs/heads/${branch}`], undefined, { cwd: repoDir });
      const diff = await this.run('git', ['diff', '--unified=0', `refs/remotes/origin/${base}...refs/heads/${branch}`], undefined, { cwd: repoDir });

      return await callback({ cwd: worktreeDir, changedFiles: parseLocalDiff(diff) });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await cleanup(this.run, repoDir, worktreeDir, dir, failed, this.logger);
    }
  }
}

async function gitAuthEnv(run, dir) {
  let token;
  try {
    token = (await run('gh', ['auth', 'token'], undefined)).trim();
  } catch (error) {
    throw new Error(`gh auth token is required for local checkout: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!token) {
    throw new Error('gh auth token is required for local checkout: gh auth token returned no token');
  }

  const tokenPath = join(dir, 'git-token');
  const askpassPath = join(dir, 'git-askpass.sh');
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  await chmod(tokenPath, 0o600);
  await writeFile(askpassPath, [
    '#!/bin/sh',
    'case "$1" in',
    "*Username*) printf '%s\\n' x-access-token ;;",
    '*) cat "$PR_REVIEW_AGENT_GIT_TOKEN_FILE" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(askpassPath, 0o700);

  return { GIT_ASKPASS: askpassPath, GIT_TERMINAL_PROMPT: '0', PR_REVIEW_AGENT_GIT_TOKEN_FILE: tokenPath };
}

export function parseLocalDiff(diff) {
  return parseDiffPatches(diff).map(({ path, patch }) => ({ path, patch, additions: parseAddedLines(patch) }));
}

function parseDiffPatches(diff) {
  const patches = [];
  let currentPath;
  let currentLines = [];

  const flush = () => {
    if (currentPath && currentLines.length > 0) {
      patches.push({ path: currentPath, patch: currentLines.join('\n') });
    }
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = parseDiffHeaderPath(line);
      currentLines = [line];
      continue;
    }
    if (currentLines.length === 0) {
      continue;
    }
    currentLines.push(line);
    const patchPath = parsePatchPath(line);
    if (patchPath) {
      currentPath = patchPath;
    }
  }

  flush();
  return patches;
}

function parseDiffHeaderPath(line) {
  const quoted = line.match(/^diff --git "((?:\\.|[^"])*)" "((?:\\.|[^"])*)"$/);
  if (quoted) {
    return stripGitPrefix(decodeGitQuotedPath(quoted[2]), 'b/');
  }

  return line.match(/^diff --git a\/(.+) b\/(.+)$/)?.[2];
}

function parsePatchPath(line) {
  if (line === '+++ /dev/null') {
    return undefined;
  }

  const quoted = line.match(/^\+\+\+ "((?:\\.|[^"])*)"$/);
  if (quoted) {
    return stripGitPrefix(decodeGitQuotedPath(quoted[1]), 'b/');
  }

  return line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : undefined;
}

function stripGitPrefix(path, prefix) {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function decodeGitQuotedPath(path) {
  let result = '';
  let bytes = [];
  const escapes = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };
  const flushBytes = () => {
    if (bytes.length > 0) {
      result += Buffer.from(bytes).toString('utf8');
      bytes = [];
    }
  };

  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char !== '\\') {
      flushBytes();
      result += char;
      continue;
    }

    if (index + 1 >= path.length) {
      flushBytes();
      result += '\\';
      break;
    }

    const escaped = path[index + 1];
    index += 1;
    if (escaped >= '0' && escaped <= '7') {
      let octal = escaped;
      while (octal.length < 3 && path[index + 1] >= '0' && path[index + 1] <= '7') {
        index += 1;
        octal += path[index];
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    flushBytes();
    result += escapes[escaped] ?? escaped;
  }

  flushBytes();
  return result;
}

async function cleanup(run, repoDir, worktreeDir, dir, failed, logger) {
  let cleanupError;
  try {
    await run('git', ['worktree', 'remove', '--force', worktreeDir], undefined, { cwd: repoDir });
  } catch (error) {
    cleanupError = error;
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    cleanupError ??= error;
  }

  if (!cleanupError) {
    return;
  }
  if (!failed) {
    throw cleanupError;
  }
  logger.warn('cleanup failed after original error', cleanupError);
}

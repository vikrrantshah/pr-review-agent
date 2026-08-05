import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { LocalReviewWorktree, parseLocalDiff } from '../src/local-review-worktree.js';

type RunCall = { command: string; args: string[]; input: string | undefined; cwd: string | undefined; env?: Record<string, string | undefined> };

const roots: string[] = [];
const request = {
  number: 7,
  baseRefName: 'develop',
  repository: { owner: 'acme', repo: 'app', nameWithOwner: 'acme/app' },
};

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'local-review-worktree-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('LocalReviewWorktree', () => {
  test('parses local diffs into changed files with added line numbers', () => {
    const changedFiles = parseLocalDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      ' const existing = true;',
      '+const added = true;',
      ' const kept = true;',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+export const b = true;',
      'diff --git "a/src/quoted\\tname.ts" "b/src/quoted\\tname.ts"',
      '--- "a/src/quoted\\tname.ts"',
      '+++ "b/src/quoted\\tname.ts"',
      '@@ -2,0 +3 @@',
      '+tabbed();',
    ].join('\n'));

    expect(changedFiles.map((file) => ({ path: file.path, additions: [...file.additions] }))).toEqual([
      { path: 'src/a.ts', additions: [2] },
      { path: 'src/b.ts', additions: [1] },
      { path: 'src/quoted\tname.ts', additions: [3] },
    ]);
    expect(changedFiles[0]?.patch).toContain('+const added = true;');
  });

  test('checks out a PR in a unique worktree and removes it after success', async () => {
    const rootDir = await tempRoot();
    const calls: RunCall[] = [];
    const dir = join(rootDir, 'acme-app-7-abc123');
    const repoDir = join(dir, 'repo');
    const worktreeDir = join(dir, 'worktree');
    let dirMode: number | undefined;
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd, ...(options?.env ? { env: options.env } : {}) });
        if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
          return 'fake-token\n';
        }
        if (args[0] === 'diff') {
          return [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -0,0 +1 @@',
            '+ok();',
          ].join('\n');
        }
        return '';
      },
    });

    const checkout = await local.withCheckout(request, async (checkout) => {
      dirMode = (await stat(dir)).mode & 0o777;
      return checkout;
    });

    expect(checkout.cwd).toBe(worktreeDir);
    expect(dirMode).toBe(0o700);
    expect(checkout.changedFiles.map((file) => ({ path: file.path, additions: [...file.additions] }))).toEqual([
      { path: 'src/a.ts', additions: [1] },
    ]);
    expect(calls).toEqual([
      { command: 'git', args: ['init', repoDir], input: undefined, cwd: undefined },
      { command: 'git', args: ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], input: undefined, cwd: repoDir },
      { command: 'gh', args: ['auth', 'token'], input: undefined, cwd: undefined },
      {
        command: 'git',
        args: ['fetch', 'origin', '+refs/heads/develop:refs/remotes/origin/develop', '+refs/pull/7/head:refs/heads/pr-7'],
        input: undefined,
        cwd: repoDir,
        env: expect.objectContaining({ GIT_ASKPASS: expect.any(String), GIT_TERMINAL_PROMPT: '0' }),
      },
      { command: 'git', args: ['worktree', 'add', '--detach', worktreeDir, 'refs/heads/pr-7'], input: undefined, cwd: repoDir },
      { command: 'git', args: ['diff', '--unified=0', 'refs/remotes/origin/develop...refs/heads/pr-7'], input: undefined, cwd: repoDir },
      { command: 'git', args: ['worktree', 'remove', '--force', worktreeDir], input: undefined, cwd: repoDir },
    ]);
  });

  test('runs git operations with the configured git timeout', async () => {
    const rootDir = await tempRoot();
    const timeouts: { args: string[]; timeoutMs: number | undefined }[] = [];
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      gitTimeoutMs: 1234,
      run: async (command, args, _input, options) => {
        if (command === 'git') {
          timeouts.push({ args, timeoutMs: options?.timeoutMs });
        }
        if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
          return 'fake-token\n';
        }
        return '';
      },
    });

    await local.withCheckout(request, async () => undefined);

    const fetchCall = timeouts.find((call) => call.args[0] === 'fetch');
    expect(fetchCall?.timeoutMs).toBe(1234);
    expect(timeouts.every((call) => call.timeoutMs === 1234)).toBe(true);
  });

  test('skips worktree removal and does not warn when setup fails before the worktree exists', async () => {
    const rootDir = await tempRoot();
    const calls: RunCall[] = [];
    const warnings: unknown[][] = [];
    const fetchError = new Error('git timed out after 300000ms');
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd });
        if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
          return 'fake-token\n';
        }
        if (args[0] === 'fetch') {
          throw fetchError;
        }
        return '';
      },
    });

    await expect(local.withCheckout(request, async () => undefined)).rejects.toBe(fetchError);

    expect(calls.some((call) => call.command === 'git' && call.args[0] === 'worktree' && call.args[1] === 'remove')).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  test('authenticates local fetches with gh token through non-interactive askpass env', async () => {
    const rootDir = await tempRoot();
    const calls: RunCall[] = [];
    let fetchEnv: Record<string, string | undefined> | undefined;
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd, ...(options?.env ? { env: options.env } : {}) });
        if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
          return 'fake-token\n';
        }
        if (args[0] === 'fetch') {
          fetchEnv = options?.env;
        }
        return '';
      },
    });

    await local.withCheckout(request, async () => undefined);

    const ghIndex = calls.findIndex((call) => call.command === 'gh' && call.args.join(' ') === 'auth token');
    const fetchIndex = calls.findIndex((call) => call.command === 'git' && call.args[0] === 'fetch');
    expect(ghIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeGreaterThan(ghIndex);
    expect(fetchEnv).toEqual(expect.objectContaining({ GIT_ASKPASS: expect.any(String), GIT_TERMINAL_PROMPT: '0' }));
    expect(fetchEnv?.GIT_ASKPASS).toContain(join(rootDir, 'acme-app-7-abc123'));
    expect(calls.flatMap((call) => call.args)).not.toContain('fake-token');
  });

  test.each([
    ['missing', async () => ''],
    ['failed', async () => {
      throw new Error('not logged in');
    }],
  ])('throws a clear error before git fetch when gh auth token is %s', async (_case, ghToken) => {
    const rootDir = await tempRoot();
    const calls: RunCall[] = [];
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd, ...(options?.env ? { env: options.env } : {}) });
        if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
          return ghToken();
        }
        if (args[0] === 'fetch') {
          throw new Error('git fetch should not run');
        }
        return '';
      },
    });

    await expect(local.withCheckout(request, async () => undefined)).rejects.toThrow(/gh auth token/i);

    expect(calls.some((call) => call.command === 'git' && call.args[0] === 'fetch')).toBe(false);
  });

  test('rejects requests without a base ref name before running git', async () => {
    const rootDir = await tempRoot();
    const calls: RunCall[] = [];
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd });
        return '';
      },
    });

    await expect(local.withCheckout({ number: 8, repository: request.repository }, async () => undefined)).rejects.toThrow('baseRefName is required');

    expect(calls).toEqual([]);
  });

  test('removes the worktree after callback failure without replacing the callback error', async () => {
    const rootDir = await tempRoot();
    const calls: RunCall[] = [];
    const callbackError = new Error('review failed');
    const warnings: unknown[][] = [];
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd, ...(options?.env ? { env: options.env } : {}) });
        if (command === 'gh' && args[0] === 'auth' && args[1] === 'token') {
          return 'fake-token\n';
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          throw new Error('cleanup failed');
        }
        return '';
      },
    });

    let thrown: unknown;
    try {
      await local.withCheckout(request, async () => {
        throw callbackError;
      });
    } catch (error) {
      thrown = error;
    }

    const worktreeDir = join(rootDir, 'acme-app-7-abc123', 'worktree');
    expect(thrown).toBe(callbackError);
    expect(calls.at(-1)).toMatchObject({ command: 'git', args: ['worktree', 'remove', '--force', worktreeDir] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toMatch(/cleanup failed/i);
    expect(warnings[0]?.[1]).toBeInstanceOf(Error);
  });
});

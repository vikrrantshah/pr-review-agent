import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { LocalReviewWorktree, parseLocalDiff } from '../src/local-review-worktree.js';

type RunCall = { command: string; args: string[]; input: string | undefined; cwd: string | undefined };

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
        calls.push({ command, args, input, cwd: options?.cwd });
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
      { command: 'git', args: ['fetch', 'origin', '+refs/heads/develop:refs/remotes/origin/develop', '+refs/pull/7/head:refs/heads/pr-7'], input: undefined, cwd: repoDir },
      { command: 'git', args: ['worktree', 'add', '--detach', worktreeDir, 'refs/heads/pr-7'], input: undefined, cwd: repoDir },
      { command: 'git', args: ['diff', '--unified=0', 'refs/remotes/origin/develop...refs/heads/pr-7'], input: undefined, cwd: repoDir },
      { command: 'git', args: ['worktree', 'remove', '--force', worktreeDir], input: undefined, cwd: repoDir },
    ]);
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
    const local = new LocalReviewWorktree({
      rootDir,
      id: () => 'abc123',
      run: async (command, args, input, options) => {
        calls.push({ command, args, input, cwd: options?.cwd });
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
  });
});

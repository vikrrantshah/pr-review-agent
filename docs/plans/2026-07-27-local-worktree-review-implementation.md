# Local Worktree Review Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Review every PR from a local worktree so large pull requests are not limited by GitHub's diff API caps.

**Architecture:** Keep GitHub APIs for queueing, metadata, existing comments/reviews/threads, and review submission. Add a local checkout path that fetches each PR into an isolated temporary worktree, builds the changed-file diff locally, and runs `pi` from that worktree via a `cwd` option. Cleanup must run after success and failure.

**Tech Stack:** Node.js ESM, `child_process.spawn`, `gh`, `git`, Vitest.

---

## Pre-flight

There are currently uncommitted changes from the oversized GitHub diff fallback:

- `src/github-adapter.js`
- `test/github-adapter.test.ts`

Before implementing this plan, either commit those changes or intentionally include them in Task 4 if they are still desired. Do not overwrite them accidentally.

---

### Task 1: Pass `cwd` through process execution

**Files:**
- Modify: `src/process-runner.js:5-45`
- Modify: `test/process-runner.test.ts:1-12`

**Step 1: Write the failing test**

Add this test to `test/process-runner.test.ts`:

```ts
test('runs a command from the requested working directory', async () => {
  const output = await runProcess(process.execPath, ['-e', 'console.log(process.cwd())'], undefined, { cwd: '/tmp' });

  expect(output.trim()).toBe('/tmp');
});
```

If `/tmp` is not portable enough on this machine, use `mkdtemp(join(tmpdir(), 'pr-review-agent-cwd-'))` and assert that path instead.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run test/process-runner.test.ts
```

Expected: new test fails because `runProcess` ignores `cwd`.

**Step 3: Write minimal implementation**

Change `runProcess` signature and spawn call:

```js
export function runProcess(command, args, input, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd });
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run test/process-runner.test.ts
```

Expected: all process-runner tests pass.

**Step 5: Commit**

```bash
git add src/process-runner.js test/process-runner.test.ts
git commit -m "feat(process): support command cwd"
```

---

### Task 2: Pass `cwd` through `PiAdapter`

**Files:**
- Modify: `src/pi-adapter.js:22-24`
- Modify: `test/pi-adapter.test.ts:1-80`

**Step 1: Write the failing test**

Add a test to `test/pi-adapter.test.ts`:

```ts
test('passes cwd to Pi process execution', async () => {
  const calls: { cwd: string | undefined }[] = [];
  const adapter = new PiAdapter({
    run: async (_command: string, _args: string[], _input: string, options?: RunOptions & { cwd?: string }) => {
      calls.push({ cwd: options?.cwd });
      return '{"findings":[]}';
    },
  });

  await adapter.review('prompt text', { cwd: '/tmp/pr-worktree' });

  expect(calls).toEqual([{ cwd: '/tmp/pr-worktree' }]);
});
```

Update `RunOptions` in the test to include `cwd?: string`.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run test/pi-adapter.test.ts
```

Expected: new test fails because `PiAdapter.review` does not accept/pass `cwd`.

**Step 3: Write minimal implementation**

Change `review`:

```js
async review(prompt, { cwd } = {}) {
  return this.run('pi', this.#args(), prompt, { timeoutMs: this.timeoutMs, cwd });
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run test/pi-adapter.test.ts
```

Expected: all Pi adapter tests pass.

**Step 5: Commit**

```bash
git add src/pi-adapter.js test/pi-adapter.test.ts
git commit -m "feat(pi): run reviews from cwd"
```

---

### Task 3: Add local PR checkout component

**Files:**
- Create: `src/local-review-worktree.js`
- Create: `test/local-review-worktree.test.ts`

**Step 1: Write failing cleanup and command tests**

Create `test/local-review-worktree.test.ts` with tests around an injected runner, not real git:

```ts
import { describe, expect, test } from 'vitest';
import { LocalReviewWorktree } from '../src/local-review-worktree.js';

const request = {
  number: 7,
  repository: { owner: 'acme', repo: 'app', nameWithOwner: 'acme/app' },
};

describe('LocalReviewWorktree', () => {
  test('fetches base and head refs into a unique worktree and cleans up', async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const local = new LocalReviewWorktree({
      rootDir: '/tmp/reviews',
      id: () => 'abc123',
      run: async (command, args, _input, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        if (args[0] === 'diff') return 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+ok();';
        return '';
      },
    });

    const result = await local.withCheckout(request, async (checkout) => checkout);

    expect(result.cwd).toBe('/tmp/reviews/acme-app-7-abc123/worktree');
    expect(result.changedFiles[0]?.path).toBe('src/a.ts');
    expect(result.changedFiles[0]?.additions.has(1)).toBe(true);
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([
      ['git', 'init'],
      ['git', 'remote'],
      ['git', 'fetch'],
      ['git', 'worktree'],
      ['git', 'diff'],
      ['git', 'worktree'],
    ]);
  });

  test('cleans up when callback fails', async () => {
    const calls: string[] = [];
    const local = new LocalReviewWorktree({
      rootDir: '/tmp/reviews',
      id: () => 'abc123',
      run: async (_command, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'diff') return '';
        return '';
      },
    });

    await expect(local.withCheckout(request, async () => { throw new Error('review failed'); })).rejects.toThrow('review failed');

    expect(calls.some((args) => args.startsWith('worktree remove'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run test/local-review-worktree.test.ts
```

Expected: fails because `src/local-review-worktree.js` does not exist.

**Step 3: Write minimal implementation**

Create `src/local-review-worktree.js`:

```js
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { runProcess } from './process-runner.js';
import { parseAddedLines } from './github-adapter.js';

export class LocalReviewWorktree {
  constructor({ run = runProcess, rootDir = join(tmpdir(), 'pr-review-agent-worktrees'), id = randomUUID } = {}) {
    this.run = run;
    this.rootDir = rootDir;
    this.id = id;
  }

  async withCheckout(request, callback) {
    const checkout = await this.#checkout(request);
    try {
      return await callback(checkout);
    } finally {
      await this.#cleanup(checkout);
    }
  }

  async #checkout(request) {
    const safeRepo = request.repository.nameWithOwner.replace(/[^a-zA-Z0-9.-]+/g, '-');
    const dir = join(this.rootDir, `${safeRepo}-${request.number}-${this.id()}`);
    const repoDir = join(dir, 'repo');
    const worktreeDir = join(dir, 'worktree');
    const remote = `https://github.com/${request.repository.nameWithOwner}.git`;
    const baseRef = 'refs/remotes/origin/base';
    const headRef = 'FETCH_HEAD';

    await this.run('git', ['init', repoDir], undefined);
    await this.run('git', ['remote', 'add', 'origin', remote], undefined, { cwd: repoDir });
    await this.run('git', ['fetch', '--depth=1', 'origin', `pull/${request.number}/head`, `pull/${request.number}/base:base`], undefined, { cwd: repoDir });
    await this.run('git', ['worktree', 'add', '--detach', worktreeDir, headRef], undefined, { cwd: repoDir });
    const diff = await this.run('git', ['diff', '--unified=200', baseRef, headRef], undefined, { cwd: repoDir });

    return { cwd: worktreeDir, changedFiles: parseLocalDiff(diff) };
  }

  async #cleanup(checkout) {
    try {
      await this.run('git', ['worktree', 'remove', '--force', checkout.cwd], undefined);
    } catch {
      // ponytail: cleanup errors are non-fatal; add structured logging if leaked worktrees become noisy.
    }
  }
}

export function parseLocalDiff(diff) {
  return parseDiffPatches(diff).map(({ path, patch }) => ({ path, patch, additions: parseAddedLines(patch) }));
}

function parseDiffPatches(diff) {
  const patches = [];
  let currentPath;
  let currentLines = [];
  const flush = () => {
    if (currentPath && currentLines.length > 0) patches.push({ path: currentPath, patch: currentLines.join('\n') });
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      currentPath = undefined;
      currentLines = [line];
      continue;
    }
    if (currentLines.length === 0) continue;
    currentLines.push(line);
    if (line.startsWith('+++ b/')) currentPath = line.slice('+++ b/'.length);
  }
  flush();
  return patches;
}
```

Before implementing, verify the actual GitHub fetch ref for PR base. If `pull/<number>/base` is not supported by GitHub, fetch base branch metadata through the API and fetch `baseRefName` instead.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run test/local-review-worktree.test.ts
```

Expected: local worktree tests pass.

**Step 5: Commit**

```bash
git add src/local-review-worktree.js test/local-review-worktree.test.ts
git commit -m "feat(git): add local review worktrees"
```

---

### Task 4: Wire local worktree review into orchestrator

**Files:**
- Modify: `src/orchestrator.js:4-86`
- Modify: `src/cli.js:12-19`
- Modify: `test/orchestrator.test.ts:52-235`

**Step 1: Write failing orchestrator test**

Add an injected `localReview` dependency to an orchestrator test:

```ts
test('runs Pi from the local PR worktree', async () => {
  const github = makeGithub([reviewRequest()]);
  const state = new MemoryState();
  const piCalls: Array<{ cwd: string | undefined }> = [];
  const localReview = {
    async withCheckout(_request, callback) {
      return callback({
        cwd: '/tmp/pr-worktree',
        changedFiles: [{ path: 'src/app.ts', patch: '@@ -1 +1 @@\n+ok();', additions: new Set([1]) }],
      });
    },
  };
  const pi: PiPort = {
    async review(_prompt, options) {
      piCalls.push({ cwd: options?.cwd });
      return '{"findings":[]}';
    },
  };

  const result = await new Orchestrator({ github, pi, state, localReview, dryRun: false }).runTick();

  expect(result.reviewed).toBe(1);
  expect(piCalls).toEqual([{ cwd: '/tmp/pr-worktree' }]);
});
```

This will require widening the `PiPort` type in `src/types.ts` later.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run test/orchestrator.test.ts
```

Expected: fails because `Orchestrator` ignores `localReview` and `PiAdapter` options.

**Step 3: Write minimal implementation**

Change constructor:

```js
constructor({ github, pi, state, localReview, dryRun = false, concurrency = 3, logger = console }) {
  this.github = github;
  this.pi = pi;
  this.state = state;
  this.localReview = localReview;
```

Change review flow:

```js
this.#log(reviewLogEvent('review_started', request));
const metadata = await this.github.getReviewContext(request);
await this.localReview.withCheckout(request, async (checkout) => {
  const context = { ...metadata, changedFiles: checkout.changedFiles };
  const prompt = this.github.buildPrompt(context);
  const result = parseReviewResult(await this.pi.review(prompt, { cwd: checkout.cwd }));
  const decision = formatReviewDecision({ findings: result.findings, changedFiles: context.changedFiles });
  const counts = countFindings(result.findings);

  if (!this.dryRun) {
    await this.github.submitReview(request, decision);
    await this.state.markHandled(request.id, request.marker);
  }
  summary.reviewed += 1;
  this.#log(reviewLogEvent('review_completed', request, {
    ...counts,
    commentsPosted: this.dryRun ? 0 : decision.comments.length,
    action: reviewAction(decision.event, this.dryRun),
  }));
});
```

Update `src/cli.js` to pass:

```js
localReview: new LocalReviewWorktree(),
```

Import `LocalReviewWorktree`.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run test/orchestrator.test.ts
```

Expected: orchestrator tests pass.

**Step 5: Commit**

```bash
git add src/orchestrator.js src/cli.js test/orchestrator.test.ts src/types.ts
git commit -m "feat(review): run pi in PR worktree"
```

---

### Task 5: Retire API diff dependency from normal context

**Files:**
- Modify: `src/github-adapter.js:78-103`
- Modify: `test/github-adapter.test.ts:189-475`

**Step 1: Write failing test**

Update GitHub context tests so `getReviewContext` no longer requires file patch availability for normal review metadata. The changed files will come from the local checkout in Task 4.

Add/adjust a test:

```ts
test('gets review metadata without fetching PR files', async () => {
  const calls: string[][] = [];
  const adapter = new GitHubAdapter({
    execGh: async (args) => {
      calls.push(args);
      if (args[0] === 'graphql') {
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
      }
      return JSON.stringify([]);
    },
  });

  const context = await adapter.getReviewContext({
    id: 'PR_15',
    marker: '2026-07-16T14:00:00Z',
    number: 15,
    title: 'Metadata only PR',
    url: 'https://github.com/acme/a/pull/15',
    repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
  });

  expect(context.changedFiles).toEqual([]);
  expect(calls.some((args) => args.join(' ').includes('/pulls/15/files'))).toBe(false);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm vitest run test/github-adapter.test.ts
```

Expected: fails because current context fetches `/pulls/<number>/files`.

**Step 3: Write minimal implementation**

Remove the files request from `getReviewContext` and return `changedFiles: []` from GitHub metadata. Keep `buildPrompt(context)` unchanged; it will receive local changed files from orchestrator.

Delete or repurpose tests that only exist for the API patch fallback. If the prior oversized-diff fallback commit is retained, keep it as fallback coverage only until this local path fully replaces it.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm vitest run test/github-adapter.test.ts
```

Expected: GitHub adapter tests pass.

**Step 5: Commit**

```bash
git add src/github-adapter.js test/github-adapter.test.ts
git commit -m "refactor(github): fetch review metadata only"
```

---

### Task 6: Full verification and manual smoke plan

**Files:**
- No required source changes.

**Step 1: Run full suite**

Run:

```bash
pnpm test
```

Expected: all tests pass.

**Step 2: Run dry-run smoke if credentials are available**

Run:

```bash
node src/cli.js --once --dry-run --log-format pretty --concurrency 1
```

Expected: one tick runs without GitHub diff-size failures. If the queue has no PRs, report that the command ran but did not exercise a review.

**Step 3: Commit if smoke required code changes**

Only commit if this task changed files:

```bash
git add <changed-files>
git commit -m "fix(review): stabilize local smoke"
```

---

## Final checks before push

Run:

```bash
pnpm test
git status --short --branch
```

Expected:

- Vitest reports all tests passing.
- Working tree is clean except intentional unpushed commits.

Before pushing, ask whether acceptance tests should be run if an acceptance pipeline exists. This repo currently has no acceptance pipeline.

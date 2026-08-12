import { describe, expect, test } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import type { ChangedFile, GitHubPort, PiPort, ReviewRequest, StatePort } from '../src/types.js';

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: 'PR_1',
    marker: '2026-07-15T10:00:00Z',
    number: 1,
    title: 'Test PR',
    url: 'https://github.com/acme/a/pull/1',
    baseRefName: 'main',
    repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
    author: 'kerrin',
    requestedAt: '2026-07-14T10:00:00Z',
    additions: 42,
    deletions: 7,
    changedFiles: 3,
    ...overrides,
  };
}

class MemoryState implements StatePort {
  handled = new Set<string>();
  async isHandled(prId: string, marker: string) {
    return this.handled.has(`${prId}:${marker}`);
  }
  async markHandled(prId: string, marker: string) {
    this.handled.add(`${prId}:${marker}`);
  }
}

function makeGithub(requests: ReviewRequest[]): GitHubPort & { submitted: unknown[] } {
  return {
    submitted: [],
    async listPersonalReviewRequests() {
      return requests;
    },
    async getReviewContext() {
      return {
        pullRequest: requests[0]!,
        changedFiles: [{ path: 'src/app.ts', additions: new Set([10]) }],
        issueComments: [],
        reviews: [],
        reviewComments: [],
        reviewThreads: [],
      };
    },
    buildPrompt() {
      return 'prompt';
    },
    async submitReview(_request, decision) {
      this.submitted.push(decision);
    },
  };
}

function makeLocalReview(changedFiles: ChangedFile[] = [{ path: 'src/app.ts', additions: new Set([10]) }]) {
  return {
    async withCheckout(_request: ReviewRequest, callback: (checkout: { cwd: string; changedFiles: ChangedFile[] }) => unknown) {
      return callback({ cwd: '/tmp/pr-worktree', changedFiles });
    },
  };
}

describe('Orchestrator', () => {
  test('skips an already handled marker and reviews a new marker', async () => {
    const state = new MemoryState();
    await state.markHandled('PR_1', 'old-marker');
    const github = makeGithub([reviewRequest({ marker: 'old-marker' }), reviewRequest({ marker: 'new-marker' })]);
    const pi: PiPort = { async review() { return '{"findings":[]}'; } };

    const result = await new Orchestrator({ github, pi, state, localReview: makeLocalReview(), dryRun: false }).runTick();

    expect(result.reviewed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(github.submitted).toHaveLength(1);
    expect(await state.isHandled('PR_1', 'new-marker')).toBe(true);
  });

  test('runs Pi from the local PR worktree with checkout files', async () => {
    const github = makeGithub([reviewRequest()]);
    const state = new MemoryState();
    const checkoutChangedFiles: ChangedFile[] = [{ path: 'src/app.ts', patch: '@@ -0,0 +1 @@\n+ok();', additions: new Set([1]) }];
    let promptChangedFiles: ChangedFile[] | undefined;
    const localReview = {
      async withCheckout(_request: ReviewRequest, callback: (checkout: { cwd: string; changedFiles: ChangedFile[] }) => Promise<unknown>) {
        return callback({ cwd: '/tmp/pr-worktree', changedFiles: checkoutChangedFiles });
      },
    };
    github.buildPrompt = (context) => {
      promptChangedFiles = context.changedFiles;
      return 'prompt';
    };
    const piCalls: Array<{ cwd: string | undefined }> = [];
    const pi: PiPort = {
      async review(_prompt, options) {
        piCalls.push({ cwd: options?.cwd });
        return '{"findings":[]}';
      },
    };

    const result = await new Orchestrator({ github, pi, state, localReview, dryRun: false }).runTick();

    expect({ reviewed: result.reviewed, promptChangedFiles, piCalls }).toEqual({
      reviewed: 1,
      promptChangedFiles: checkoutChangedFiles,
      piCalls: [{ cwd: '/tmp/pr-worktree' }],
    });
  });

  test('toolkit failures do not mark the marker handled', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    const pi: PiPort = { async review() { throw new Error('pi failed'); } };

    const result = await new Orchestrator({ github, pi, state, localReview: makeLocalReview(), dryRun: false }).runTick();

    expect(result.failed).toBe(1);
    expect(github.submitted).toHaveLength(0);
    expect(await state.isHandled('PR_1', '2026-07-15T10:00:00Z')).toBe(false);
  });

  test('backs off failed reviews for the same marker', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    let piCalls = 0;
    const pi: PiPort = {
      async review() {
        piCalls += 1;
        throw new Error('pi failed');
      },
    };
    const orchestrator = new Orchestrator({ github, pi, state, localReview: makeLocalReview(), dryRun: false });
    const first = await orchestrator.runTick();
    const second = await orchestrator.runTick();

    expect(first.failed).toBe(1);
    expect(second.skipped).toBe(1);
    expect(piCalls).toBe(1);
  });

  test('GitHub submission failures do not mark the marker handled', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    github.submitReview = async () => { throw new Error('gh failed'); };
    const pi: PiPort = { async review() { return '{"findings":[]}'; } };

    const result = await new Orchestrator({ github, pi, state, localReview: makeLocalReview(), dryRun: false }).runTick();

    expect(result.failed).toBe(1);
    expect(await state.isHandled('PR_1', '2026-07-15T10:00:00Z')).toBe(false);
  });

  test('does not submit or mark handled when local checkout cleanup fails', async () => {
    const logs: Array<{ event: string }> = [];
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    const localReview = {
      async withCheckout(_request: ReviewRequest, callback: (checkout: { cwd: string; changedFiles: ChangedFile[] }) => Promise<unknown>) {
        await callback({ cwd: '/tmp/pr-worktree', changedFiles: [{ path: 'src/app.ts', additions: new Set([10]) }] });
        throw new Error('cleanup failed');
      },
    };
    const pi: PiPort = { async review() { return '{"findings":[]}'; } };

    const result = await new Orchestrator({
      github,
      pi,
      state,
      localReview,
      dryRun: false,
      logger: { log: (line: string) => logs.push(JSON.parse(line)) },
    }).runTick();

    expect(result).toMatchObject({ reviewed: 0, failed: 1 });
    expect(github.submitted).toHaveLength(0);
    expect(await state.isHandled('PR_1', '2026-07-15T10:00:00Z')).toBe(false);
    expect(logs.map((log) => log.event)).toEqual(['review_started', 'review_failed']);
  });

  test('dry-run submits nothing and leaves state unhandled', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    const pi: PiPort = { async review() { return '{"findings":[{"severity":"Important","path":"src/app.ts","line":10,"body":"Fix it."}]}'; } };

    const result = await new Orchestrator({ github, pi, state, localReview: makeLocalReview(), dryRun: true }).runTick();

    expect(result.reviewed).toBe(1);
    expect(github.submitted).toHaveLength(0);
    expect(await state.isHandled('PR_1', '2026-07-15T10:00:00Z')).toBe(false);
  });

  test('does not overlap ticks', async () => {
    const releaseGate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const github = makeGithub([reviewRequest()]);
    github.listPersonalReviewRequests = async () => {
      started.resolve();
      await releaseGate.promise;
      return [];
    };
    const orchestrator = new Orchestrator({ github, pi: { async review() { return '{"findings":[]}'; } }, state: new MemoryState(), localReview: makeLocalReview(), dryRun: false });
    const first = orchestrator.runTick();
    await started.promise;
    const second = await orchestrator.runTick();
    releaseGate.resolve();
    await first;

    expect(second.overlapped).toBe(true);
  });

  test('does not submit a duplicate review after submit succeeds but markHandled fails', async () => {
    const request = reviewRequest();
    let handled = false;
    let markAttempts = 0;
    const state: StatePort = {
      async isHandled() {
        return handled;
      },
      async markHandled() {
        markAttempts += 1;
        if (markAttempts === 1) {
          throw new Error('state write failed');
        }
        handled = true;
      },
    };
    let submittedReviewExists = false;
    const github = Object.assign(makeGithub([request]), {
      async hasSubmittedReview() {
        return submittedReviewExists;
      },
    });
    github.submitReview = async (_request, decision) => {
      github.submitted.push(decision);
      submittedReviewExists = true;
    };
    const orchestrator = new Orchestrator({ github, pi: { async review() { return '{"findings":[]}'; } }, state, localReview: makeLocalReview(), dryRun: false });

    const first = await orchestrator.runTick();
    const second = await orchestrator.runTick();

    expect(first.failed).toBe(1);
    expect(second.skipped).toBe(1);
    expect(github.submitted).toHaveLength(1);
    expect(handled).toBe(true);
  });


  test('logs PR review IO with finding counts, posted comments, and action', async () => {
    const logs: unknown[] = [];
    const github = makeGithub([reviewRequest()]);
    const pi: PiPort = {
      async review() {
        return JSON.stringify({
          findings: [
            { severity: 'Critical', path: 'src/app.ts', line: 10, body: 'Critical issue.' },
            { severity: 'Important', path: 'src/app.ts', line: 99, body: 'Important issue.' },
            { severity: 'Suggestion', body: 'Suggestion.' },
          ],
        });
      },
    };

    await new Orchestrator({
      github,
      pi,
      state: new MemoryState(),
      localReview: makeLocalReview(),
      dryRun: false,
      logger: { log: (line: string) => logs.push(JSON.parse(line)) },
    }).runTick();

    expect(logs).toEqual([
      expect.objectContaining({
        event: 'review_started',
        repo: 'acme/a',
        number: 1,
        title: 'Test PR',
        url: 'https://github.com/acme/a/pull/1',
        author: 'kerrin',
        requestedAt: '2026-07-14T10:00:00Z',
        additions: 42,
        deletions: 7,
        changedFiles: 3,
      }),
      expect.objectContaining({
        event: 'review_completed',
        repo: 'acme/a',
        number: 1,
        critical: 1,
        important: 1,
        suggestions: 1,
        commentsPosted: 1,
        action: 'request_changes',
        author: 'kerrin',
        requestedAt: '2026-07-14T10:00:00Z',
        additions: 42,
        deletions: 7,
        changedFiles: 3,
      }),
    ]);
  });
  test('reviews pending requests concurrently up to the configured limit', async () => {
    const requests = [
      reviewRequest({ id: 'PR_1', number: 1 }),
      reviewRequest({ id: 'PR_2', number: 2 }),
      reviewRequest({ id: 'PR_3', number: 3 }),
    ];
    let inFlight = 0;
    let maxInFlight = 0;
    const github = makeGithub(requests);
    github.getReviewContext = async (request) => ({
      pullRequest: request,
      changedFiles: [{ path: 'src/app.ts', additions: new Set([10]) }],
      issueComments: [],
      reviews: [],
      reviewComments: [],
      reviewThreads: [],
    });
    const pi: PiPort = {
      async review() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return '{"findings":[]}';
      },
    };

    const result = await new Orchestrator({ github, pi, state: new MemoryState(), localReview: makeLocalReview(), dryRun: false, concurrency: 2 }).runTick();

    expect(result.reviewed).toBe(3);
    expect(maxInFlight).toBe(2);
  });
});

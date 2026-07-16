import { describe, expect, test } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import type { GitHubPort, PiPort, ReviewRequest, StatePort } from '../src/types.js';

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    id: 'PR_1',
    marker: '2026-07-15T10:00:00Z',
    number: 1,
    title: 'Test PR',
    url: 'https://github.com/acme/a/pull/1',
    repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
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

describe('Orchestrator', () => {
  test('skips an already handled marker and reviews a new marker', async () => {
    const state = new MemoryState();
    await state.markHandled('PR_1', 'old-marker');
    const github = makeGithub([reviewRequest({ marker: 'old-marker' }), reviewRequest({ marker: 'new-marker' })]);
    const pi: PiPort = { async review() { return '{"findings":[]}'; } };

    const result = await new Orchestrator({ github, pi, state, dryRun: false }).runTick();

    expect(result.reviewed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(github.submitted).toHaveLength(1);
    expect(await state.isHandled('PR_1', 'new-marker')).toBe(true);
  });

  test('toolkit failures do not mark the marker handled', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    const pi: PiPort = { async review() { throw new Error('pi failed'); } };

    const result = await new Orchestrator({ github, pi, state, dryRun: false }).runTick();

    expect(result.failed).toBe(1);
    expect(github.submitted).toHaveLength(0);
    expect(await state.isHandled('PR_1', '2026-07-15T10:00:00Z')).toBe(false);
  });

  test('GitHub submission failures do not mark the marker handled', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    github.submitReview = async () => { throw new Error('gh failed'); };
    const pi: PiPort = { async review() { return '{"findings":[]}'; } };

    const result = await new Orchestrator({ github, pi, state, dryRun: false }).runTick();

    expect(result.failed).toBe(1);
    expect(await state.isHandled('PR_1', '2026-07-15T10:00:00Z')).toBe(false);
  });

  test('dry-run submits nothing and leaves state unhandled', async () => {
    const state = new MemoryState();
    const github = makeGithub([reviewRequest()]);
    const pi: PiPort = { async review() { return '{"findings":[{"severity":"Important","path":"src/app.ts","line":10,"body":"Fix it."}]}'; } };

    const result = await new Orchestrator({ github, pi, state, dryRun: true }).runTick();

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
    const orchestrator = new Orchestrator({ github, pi: { async review() { return '{"findings":[]}'; } }, state: new MemoryState(), dryRun: false });
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
    const orchestrator = new Orchestrator({ github, pi: { async review() { return '{"findings":[]}'; } }, state, dryRun: false });

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

    const result = await new Orchestrator({ github, pi, state: new MemoryState(), dryRun: false, concurrency: 2 }).runTick();

    expect(result.reviewed).toBe(3);
    expect(maxInFlight).toBe(2);
  });
});

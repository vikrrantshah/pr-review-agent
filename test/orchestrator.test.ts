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
    let release!: () => void;
    let tickStarted!: () => void;
    const started = new Promise<void>((resolve) => { tickStarted = resolve; });
    const github = makeGithub([reviewRequest()]);
    github.listPersonalReviewRequests = async () => {
      tickStarted();
      await new Promise<void>((resolve) => { release = resolve; });
      return [];
    };
    const orchestrator = new Orchestrator({ github, pi: { async review() { return '{"findings":[]}'; } }, state: new MemoryState(), dryRun: false });
    const first = orchestrator.runTick();
    await started;
    const second = await orchestrator.runTick();
    release();
    await first;

    expect(second.overlapped).toBe(true);
  });
});

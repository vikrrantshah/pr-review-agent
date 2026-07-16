import { describe, expect, test } from 'vitest';
import { GitHubAdapter } from '../src/github-adapter.js';

describe('GitHubAdapter', () => {
  test('selects direct personal review requests across repositories only', async () => {
    const adapter = new GitHubAdapter({
      execGh: async (_args, input) => {
        expect(input).toContain('review-requested:@me');
        return JSON.stringify({
          data: {
            viewer: { login: 'vikrant' },
            search: {
              nodes: [
                {
                  __typename: 'PullRequest',
                  id: 'PR_personal_a',
                  number: 1,
                  title: 'Personal A',
                  url: 'https://github.com/acme/a/pull/1',
                  repository: { owner: { login: 'acme' }, name: 'a', nameWithOwner: 'acme/a' },
                  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'vikrant' } }] },
                  timelineItems: { nodes: [
                    { __typename: 'ReviewRequestedEvent', createdAt: '2026-07-15T10:00:00Z', requestedReviewer: { __typename: 'User', login: 'vikrant' } },
                  ] },
                },
                {
                  __typename: 'PullRequest',
                  id: 'PR_team',
                  number: 2,
                  title: 'Team only',
                  url: 'https://github.com/acme/b/pull/2',
                  repository: { owner: { login: 'acme' }, name: 'b', nameWithOwner: 'acme/b' },
                  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'platform' } }] },
                  timelineItems: { nodes: [
                    { __typename: 'ReviewRequestedEvent', createdAt: '2026-07-15T11:00:00Z', requestedReviewer: { __typename: 'Team', slug: 'platform' } },
                  ] },
                },
                {
                  __typename: 'PullRequest',
                  id: 'PR_personal_b',
                  number: 3,
                  title: 'Personal B',
                  url: 'https://github.com/other/c/pull/3',
                  repository: { owner: { login: 'other' }, name: 'c', nameWithOwner: 'other/c' },
                  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'vikrant' } }] },
                  timelineItems: { nodes: [
                    { __typename: 'ReviewRequestedEvent', createdAt: '2026-07-16T09:00:00Z', requestedReviewer: { __typename: 'User', login: 'vikrant' } },
                  ] },
                },
              ],
            },
          },
        });
      },
    });

    const requests = await adapter.listPersonalReviewRequests();

    expect(requests.map((request) => request.repository.nameWithOwner)).toEqual(['acme/a', 'other/c']);
    expect(requests.map((request) => request.marker)).toEqual(['2026-07-15T10:00:00Z', '2026-07-16T09:00:00Z']);
  });

  test('builds a prompt context containing comments, reviews, and review-thread replies', async () => {
    const calls: string[][] = [];
    const adapter = new GitHubAdapter({
      execGh: async (args) => {
        calls.push(args);
        const joined = args.join(' ');
        if (joined.includes('/pulls/7/files')) {
          return JSON.stringify([{ filename: 'src/app.ts', patch: '@@ -1 +1 @@\n+const value = 1;', additions: 1 }]);
        }
        if (joined.includes('/issues/7/comments')) {
          return JSON.stringify([{ user: { login: 'alice' }, body: 'Issue comment context' }]);
        }
        if (joined.includes('/pulls/7/reviews')) {
          return JSON.stringify([{ user: { login: 'bob' }, state: 'COMMENTED', body: 'Review summary context' }]);
        }
        if (joined.includes('/pulls/7/comments')) {
          return JSON.stringify([{ user: { login: 'carol' }, path: 'src/app.ts', line: 1, body: 'Inline review comment context' }]);
        }
        if (args[0] === 'graphql') {
          return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
            { isResolved: false, path: 'src/app.ts', line: 1, comments: { nodes: [
              { author: { login: 'dave' }, body: 'Thread root context' },
              { author: { login: 'erin' }, body: 'Thread reply context' },
            ] } },
          ] } } } } });
        }
        throw new Error(`Unexpected gh call: ${joined}`);
      },
    });

    const context = await adapter.getReviewContext({
      id: 'PR_7',
      marker: '2026-07-16T10:00:00Z',
      number: 7,
      title: 'Context PR',
      url: 'https://github.com/acme/a/pull/7',
      repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
    });
    const prompt = adapter.buildPrompt(context);

    expect(prompt).toContain('Issue comment context');
    expect(prompt).toContain('Review summary context');
    expect(prompt).toContain('Inline review comment context');
    expect(prompt).toContain('Thread root context');
    expect(prompt).toContain('Thread reply context');
    expect(context.changedFiles[0]?.additions.has(1)).toBe(true);
    expect(calls.length).toBe(5);
  });
});

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

  test('fetches every GraphQL search page for personal review requests', async () => {
    const graphqlInputs: string[] = [];
    const adapter = new GitHubAdapter({
      execGh: async (_args, input) => {
        graphqlInputs.push(input ?? '');
        const secondPage = input?.includes('after: "search-cursor-1"');
        return JSON.stringify({
          data: {
            viewer: { login: 'vikrant' },
            search: {
              pageInfo: { hasNextPage: !secondPage, endCursor: secondPage ? null : 'search-cursor-1' },
              nodes: [
                {
                  __typename: 'PullRequest',
                  id: secondPage ? 'PR_second_page' : 'PR_first_page',
                  number: secondPage ? 2 : 1,
                  title: secondPage ? 'Second page' : 'First page',
                  url: `https://github.com/acme/repo/pull/${secondPage ? 2 : 1}`,
                  repository: { owner: { login: 'acme' }, name: 'repo', nameWithOwner: 'acme/repo' },
                  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'vikrant' } }] },
                  timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
                    { __typename: 'ReviewRequestedEvent', createdAt: secondPage ? '2026-07-16T10:00:00Z' : '2026-07-15T10:00:00Z', requestedReviewer: { __typename: 'User', login: 'vikrant' } },
                  ] },
                },
              ],
            },
          },
        });
      },
    });

    const requests = await adapter.listPersonalReviewRequests();

    expect(graphqlInputs).toHaveLength(2);
    expect(graphqlInputs[1]).toContain('after: "search-cursor-1"');
    expect(requests.map((request) => request.id)).toEqual(['PR_first_page', 'PR_second_page']);
  });

  test('uses paginated timeline events to select the current personal review marker', async () => {
    const graphqlInputs: string[] = [];
    const adapter = new GitHubAdapter({
      execGh: async (_args, input) => {
        graphqlInputs.push(input ?? '');
        if (input?.includes('after: "timeline-cursor-1"')) {
          return JSON.stringify({ data: { node: { timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { __typename: 'ReviewRequestedEvent', createdAt: '2026-07-16T10:00:00Z', requestedReviewer: { __typename: 'User', login: 'vikrant' } },
            ],
          } } } });
        }
        return JSON.stringify({
          data: {
            viewer: { login: 'vikrant' },
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  __typename: 'PullRequest',
                  id: 'PR_marker',
                  number: 11,
                  title: 'Marker PR',
                  url: 'https://github.com/acme/repo/pull/11',
                  repository: { owner: { login: 'acme' }, name: 'repo', nameWithOwner: 'acme/repo' },
                  reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'vikrant' } }] },
                  timelineItems: {
                    pageInfo: { hasNextPage: true, endCursor: 'timeline-cursor-1' },
                    nodes: [
                      { __typename: 'ReviewRequestedEvent', createdAt: '2026-07-01T10:00:00Z', requestedReviewer: { __typename: 'User', login: 'vikrant' } },
                    ],
                  },
                },
              ],
            },
          },
        });
      },
    });

    const requests = await adapter.listPersonalReviewRequests();

    expect(graphqlInputs).toHaveLength(2);
    expect(graphqlInputs[1]).toContain('PR_marker');
    expect(graphqlInputs[1]).toContain('after: "timeline-cursor-1"');
    expect(requests[0]?.marker).toBe('2026-07-16T10:00:00Z');
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

  test('fetches every REST page for pull request context', async () => {
    const calls: string[][] = [];
    const adapter = new GitHubAdapter({
      execGh: async (args) => {
        calls.push(args);
        const joined = args.join(' ');
        if (joined.includes('/pulls/8/files')) {
          return JSON.stringify([
            [{ filename: 'src/first.ts', patch: '@@ -1 +1 @@\n+first();', additions: 1 }],
            [{ filename: 'src/second.ts', patch: '@@ -2 +2 @@\n+second();', additions: 1 }],
          ]);
        }
        if (joined.includes('/issues/8/comments')) {
          return JSON.stringify([
            [{ user: { login: 'alice' }, body: 'first issue page' }],
            [{ user: { login: 'bob' }, body: 'second issue page' }],
          ]);
        }
        if (joined.includes('/pulls/8/reviews')) {
          return JSON.stringify([
            [{ user: { login: 'carol' }, state: 'COMMENTED', body: 'first review page' }],
            [{ user: { login: 'dave' }, state: 'APPROVED', body: 'second review page' }],
          ]);
        }
        if (joined.includes('/pulls/8/comments')) {
          return JSON.stringify([
            [{ user: { login: 'erin' }, path: 'src/first.ts', line: 1, body: 'first inline page' }],
            [{ user: { login: 'frank' }, path: 'src/second.ts', line: 2, body: 'second inline page' }],
          ]);
        }
        if (args[0] === 'graphql') {
          return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
        }
        throw new Error(`Unexpected gh call: ${joined}`);
      },
    });

    const context = await adapter.getReviewContext({
      id: 'PR_8',
      marker: '2026-07-16T11:00:00Z',
      number: 8,
      title: 'Paginated context PR',
      url: 'https://github.com/acme/a/pull/8',
      repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
    });

    expect(context.changedFiles.map((file) => file.path)).toEqual(['src/first.ts', 'src/second.ts']);
    expect(context.issueComments.map((comment) => comment.body)).toEqual(['first issue page', 'second issue page']);
    expect(context.reviews.map((review) => review.body)).toEqual(['first review page', 'second review page']);
    expect(context.reviewComments.map((comment) => comment.body)).toEqual(['first inline page', 'second inline page']);
    const restCalls = calls.filter((args) => args[0] !== 'graphql');
    expect(restCalls).toHaveLength(4);
    expect(restCalls.every((args) => args.includes('--paginate') && args.includes('--slurp'))).toBe(true);
  });

  test('fetches every GraphQL review-thread page', async () => {
    const graphqlInputs: string[] = [];
    const adapter = new GitHubAdapter({
      execGh: async (args, input) => {
        if (args[0] !== 'graphql') {
          return JSON.stringify([]);
        }
        graphqlInputs.push(input ?? '');
        if (!input?.includes('after: "cursor-1"')) {
          return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            nodes: [{ isResolved: false, path: 'src/first.ts', line: 1, comments: { nodes: [{ author: { login: 'alice' }, body: 'first thread' }] } }],
          } } } } });
        }
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ isResolved: true, path: 'src/second.ts', line: 2, comments: { nodes: [{ author: { login: 'bob' }, body: 'second thread' }] } }],
        } } } } });
      },
    });

    const context = await adapter.getReviewContext({
      id: 'PR_9',
      marker: '2026-07-16T12:00:00Z',
      number: 9,
      title: 'Thread pagination PR',
      url: 'https://github.com/acme/a/pull/9',
      repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
    });

    expect(graphqlInputs).toHaveLength(2);
    expect(context.reviewThreads.map((thread) => thread.comments[0]?.body)).toEqual(['first thread', 'second thread']);
  });

  test('fetches every GraphQL review-thread comment page', async () => {
    const graphqlInputs: string[] = [];
    const adapter = new GitHubAdapter({
      execGh: async (args, input) => {
        if (args[0] !== 'graphql') {
          return JSON.stringify([]);
        }
        graphqlInputs.push(input ?? '');
        if (input?.includes('after: "comment-cursor-1"')) {
          return JSON.stringify({ data: { node: { comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ author: { login: 'bob' }, body: 'comment after first 100' }],
          } } } });
        }
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'THREAD_1',
            isResolved: false,
            path: 'src/app.ts',
            line: 1,
            comments: {
              pageInfo: { hasNextPage: true, endCursor: 'comment-cursor-1' },
              nodes: [{ author: { login: 'alice' }, body: 'comment from first 100' }],
            },
          }],
        } } } } });
      },
    });

    const context = await adapter.getReviewContext({
      id: 'PR_12',
      marker: '2026-07-16T14:00:00Z',
      number: 12,
      title: 'Thread comment pagination PR',
      url: 'https://github.com/acme/a/pull/12',
      repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
    });

    expect(graphqlInputs).toHaveLength(2);
    expect(graphqlInputs[1]).toContain('THREAD_1');
    expect(graphqlInputs[1]).toContain('after: "comment-cursor-1"');
    expect(context.reviewThreads[0]?.comments.map((comment) => comment.body)).toEqual([
      'comment from first 100',
      'comment after first 100',
    ]);
  });

  test('fails closed when GitHub omits a file patch', async () => {
    const adapter = new GitHubAdapter({
      execGh: async (args) => {
        const joined = args.join(' ');
        if (joined.includes('/pulls/10/files')) {
          return JSON.stringify([{ filename: 'src/large.ts', additions: 120 }]);
        }
        if (args[0] === 'graphql') {
          return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
        }
        return JSON.stringify([]);
      },
    });

    await expect(adapter.getReviewContext({
      id: 'PR_10',
      marker: '2026-07-16T13:00:00Z',
      number: 10,
      title: 'Missing patch PR',
      url: 'https://github.com/acme/a/pull/10',
      repository: { owner: 'acme', repo: 'a', nameWithOwner: 'acme/a' },
    })).rejects.toThrow(/patch/i);
  });
});

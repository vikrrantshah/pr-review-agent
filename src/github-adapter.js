import { DEFAULT_COMMAND_TIMEOUT_MS, runProcess } from './process-runner.js';

const REVIEW_MARKER_PREFIX = '<!-- pr-review-agent:';

export class GitHubAdapter {
  constructor({ execGh, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this.execGh = execGh ?? ((args, input) => defaultExecGh(args, input, { timeoutMs }));
  }

  async listPersonalReviewRequests() {
    const nodes = [];
    let viewer;
    let cursor;

    while (true) {
      const after = cursor ? `, after: "${escapeGraphql(cursor)}"` : '';
      const query = `
query {
  viewer { login }
  search(query: "review-requested:@me is:open is:pr archived:false", type: ISSUE, first: 100${after}) {
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest {
        id
        number
        title
        url
        headRefOid
        baseRefName
        repository { name nameWithOwner owner { login } }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
        timelineItems(first: 100, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          pageInfo { hasNextPage endCursor }
          nodes {
            __typename
            ... on ReviewRequestedEvent { id createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
          }
        }
      }
    }
  }
}`;
      const payload = JSON.parse(await this.execGh(['graphql'], query));
      viewer ??= payload.data.viewer.login;
      nodes.push(...payload.data.search.nodes.filter((node) => node.__typename === 'PullRequest'));

      if (!payload.data.search.pageInfo?.hasNextPage) {
        break;
      }
      cursor = payload.data.search.pageInfo.endCursor;
    }

    const requests = [];
    for (const node of nodes) {
      const hasDirectOpenRequest = node.reviewRequests.nodes.some((request) => isViewerUser(request.requestedReviewer, viewer));
      const directEvents = (await this.#getReviewRequestTimelineEvents(node))
        .filter((event) => event.__typename === 'ReviewRequestedEvent' && isViewerUser(event.requestedReviewer, viewer))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

      if (!hasDirectOpenRequest || directEvents.length === 0) {
        continue;
      }

      const repo = node.repository;
      requests.push({
        id: node.id,
        marker: reviewRequestMarker(directEvents.at(-1), node),
        number: node.number,
        title: node.title,
        url: node.url,
        baseRefName: node.baseRefName,
        repository: { owner: repo.owner.login, repo: repo.name, nameWithOwner: repo.nameWithOwner },
      });
    }

    return requests;
  }

  async getReviewContext(request) {
    const { owner, repo } = request.repository;
    const [issueComments, reviews, reviewComments, reviewThreads] = await Promise.all([
      this.#getPaginatedJson(`repos/${owner}/${repo}/issues/${request.number}/comments`),
      this.#getPaginatedJson(`repos/${owner}/${repo}/pulls/${request.number}/reviews`),
      this.#getPaginatedJson(`repos/${owner}/${repo}/pulls/${request.number}/comments`),
      this.#getReviewThreads(owner, repo, request.number),
    ]);

    return {
      pullRequest: request,
      changedFiles: [],
      issueComments: issueComments.map((comment) => ({ author: loginOrUnknown(comment.user), body: comment.body ?? '' })),
      reviews: reviews.map((review) => ({ author: loginOrUnknown(review.user), state: review.state ?? 'UNKNOWN', body: review.body ?? '' })),
      reviewComments: reviewComments.map((comment) => ({ author: loginOrUnknown(comment.user), path: comment.path, line: comment.line ?? comment.original_line, body: comment.body ?? '' })),
      reviewThreads,
    };
  }

  buildPrompt(context) {
    const changedFiles = formatEntries(context.changedFiles, formatChangedFile);
    const diffCommand = `git diff --unified=0 refs/remotes/origin/${context.pullRequest.baseRefName}...HEAD`;
    const issueComments = formatEntries(context.issueComments, (comment) => `- ${comment.author}: ${comment.body}`);
    const reviews = formatEntries(context.reviews, (review) => `- ${review.author} [${review.state}]: ${review.body}`);
    const reviewComments = formatEntries(context.reviewComments, (comment) => `- ${comment.author} on ${comment.path}:${comment.line ?? '?'}: ${comment.body}`);
    const reviewThreads = formatEntries(context.reviewThreads, (thread) => {
      const replies = thread.comments.map((comment) => `  - ${comment.author}: ${comment.body}`).join('\n');
      return `- ${thread.path}:${thread.line ?? '?'} resolved=${thread.isResolved}\n${replies}`;
    });

    return `You are reviewing ${context.pullRequest.repository.nameWithOwner}#${context.pullRequest.number}: ${context.pullRequest.title}
URL: ${context.pullRequest.url}

Return only JSON in this shape:
{"findings":[{"severity":"Critical|Important|Suggestion","path":"path/from/diff","line":123,"body":"specific review text"}]}

Rules:
- You are running inside the PR checkout worktree.
- Inspect the local diff before deciding: ${diffCommand}
- Be lenient and pragmatic. Only report actionable defects introduced by this diff; when in doubt, downgrade the severity or omit the finding.
- Do NOT nitpick style, naming, formatting, import ordering, test coverage preferences, or subjective/opinion-based matters. Assume the team's existing conventions are intentional.
- Only Critical findings block the merge, so reserve Critical for concrete production-breaking correctness, security, or data-loss bugs you can point to in the diff. Be conservative: if you are not confident it breaks production, it is not Critical.
- Use Important for clear, non-subjective defects worth fixing that do not block the merge.
- Use Suggestion for everything else (minor, optional improvements). Prefer Suggestion whenever unsure.
- Do not restate what the code does or hand out praise; only surface real problems.
- Anchor findings to added lines in the diff whenever possible.

## Existing issue comments
${issueComments}

## Existing reviews
${reviews}

## Existing inline review comments
${reviewComments}

## Existing review threads and replies
${reviewThreads}

## Local diff command
${diffCommand}

## Changed files
${changedFiles}
`;
  }

  async submitReview(request, decision) {
    if (await this.hasSubmittedReview(request)) {
      return;
    }
    const { owner, repo } = request.repository;
    const body = JSON.stringify({ event: decision.event, body: bodyWithReviewMarker(decision.body, request), comments: decision.comments });
    await this.execGh([`repos/${owner}/${repo}/pulls/${request.number}/reviews`, '-X', 'POST', '--input', '-'], body);
  }

  async hasSubmittedReview(request) {
    const { owner, repo } = request.repository;
    const reviews = await this.#getPaginatedJson(`repos/${owner}/${repo}/pulls/${request.number}/reviews`);
    const marker = reviewMarker(request);
    return reviews.some((review) => review.body?.includes(marker));
  }

  async #getPaginatedJson(path) {
    const payload = JSON.parse(await this.execGh([path, '--paginate', '--slurp']));
    return payload.every(Array.isArray) ? payload.flat() : payload;
  }

  async #getReviewRequestTimelineEvents(node) {
    const events = [...node.timelineItems.nodes];
    let cursor = node.timelineItems.pageInfo?.endCursor;

    while (node.timelineItems.pageInfo?.hasNextPage) {
      const query = `
query {
  node(id: "${escapeGraphql(node.id)}") {
    ... on PullRequest {
      timelineItems(first: 100, after: "${escapeGraphql(cursor)}", itemTypes: [REVIEW_REQUESTED_EVENT]) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ReviewRequestedEvent { id createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
        }
      }
    }
  }
}`;
      const payload = JSON.parse(await this.execGh(['graphql'], query));
      node.timelineItems = payload.data.node.timelineItems;
      events.push(...node.timelineItems.nodes);
      cursor = node.timelineItems.pageInfo?.endCursor;
    }

    return events;
  }

  async #getReviewThreads(owner, repo, number) {
    const nodes = [];
    let cursor;
    while (true) {
      const after = cursor ? `, after: "${escapeGraphql(cursor)}"` : '';
      const query = `
query {
  repository(owner: "${escapeGraphql(owner)}", name: "${escapeGraphql(repo)}") {
    pullRequest(number: ${number}) {
      reviewThreads(first: 100${after}) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          path
          line
          comments(first: 100) {
            pageInfo { hasNextPage endCursor }
            nodes { author { login } body }
          }
        }
      }
    }
  }
}`;
      const payload = JSON.parse(await this.execGh(['graphql'], query));
      const connection = payload.data.repository.pullRequest.reviewThreads;
      nodes.push(...connection.nodes);
      if (!connection.pageInfo?.hasNextPage) {
        break;
      }
      cursor = connection.pageInfo.endCursor;
    }

    const threads = [];
    for (const thread of nodes) {
      const comments = await this.#getReviewThreadComments(thread);
      threads.push({
        path: thread.path,
        line: thread.line,
        isResolved: thread.isResolved,
        comments: comments.map((comment) => ({ author: loginOrUnknown(comment.author), body: comment.body ?? '' })),
      });
    }

    return threads;
  }

  async #getReviewThreadComments(thread) {
    const comments = [...thread.comments.nodes];
    let cursor = thread.comments.pageInfo?.endCursor;

    while (thread.comments.pageInfo?.hasNextPage) {
      const query = `
query {
  node(id: "${escapeGraphql(thread.id)}") {
    ... on PullRequestReviewThread {
      comments(first: 100, after: "${escapeGraphql(cursor)}") {
        pageInfo { hasNextPage endCursor }
        nodes { author { login } body }
      }
    }
  }
}`;
      const payload = JSON.parse(await this.execGh(['graphql'], query));
      thread.comments = payload.data.node.comments;
      comments.push(...thread.comments.nodes);
      cursor = thread.comments.pageInfo?.endCursor;
    }

    return comments;
  }
}

export function parseAddedLines(patch) {
  const additions = new Set();
  let newLine = 0;

  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+++')) {
      continue;
    }
    if (line.startsWith('+')) {
      additions.add(newLine);
      newLine += 1;
      continue;
    }
    if (!line.startsWith('-') && newLine > 0) {
      newLine += 1;
    }
  }

  return additions;
}

function bodyWithReviewMarker(body, request) {
  return `${body}\n\n${reviewMarker(request)}`;
}

function reviewMarker(request) {
  return `${REVIEW_MARKER_PREFIX}${request.id}:${request.marker} -->`;
}

function reviewRequestMarker(event, pullRequest) {
  const eventPart = event.id ?? event.createdAt;
  const headPart = pullRequest.headRefOid ?? 'unknown-head';
  return `${eventPart}:${headPart}`;
}

function isViewerUser(requestedReviewer, viewer) {
  return requestedReviewer?.__typename === 'User' && requestedReviewer.login === viewer;
}

function loginOrUnknown(user) {
  return user?.login ?? 'unknown';
}

function formatEntries(entries, formatter) {
  if (entries.length === 0) {
    return '(none)';
  }
  return entries.map(formatter).join('\n');
}

function formatChangedFile(file) {
  const additions = file.additions.size;
  return `- ${file.path} (${additions} added lines)`;
}

function escapeGraphql(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function defaultExecGh(args, input, { timeoutMs }) {
  const ghArgs = args[0] === 'graphql' ? ['api', 'graphql', '-f', `query=${input ?? ''}`] : ['api', ...args];
  const stdin = args[0] === 'graphql' ? undefined : input;
  return runProcess('gh', ghArgs, stdin, { timeoutMs });
}

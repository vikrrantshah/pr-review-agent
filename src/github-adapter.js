import { spawn } from 'node:child_process';

const REVIEW_REQUEST_QUERY = `
query {
  viewer { login }
  search(query: "review-requested:@me is:open is:pr archived:false", type: ISSUE, first: 100) {
    nodes {
      __typename
      ... on PullRequest {
        id
        number
        title
        url
        repository { name nameWithOwner owner { login } }
        reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
        timelineItems(last: 50, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          nodes {
            __typename
            ... on ReviewRequestedEvent { createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } } }
          }
        }
      }
    }
  }
}`;

export class GitHubAdapter {
  constructor({ execGh = defaultExecGh } = {}) {
    this.execGh = execGh;
  }

  async listPersonalReviewRequests() {
    const payload = JSON.parse(await this.execGh(['graphql'], REVIEW_REQUEST_QUERY));
    const viewer = payload.data.viewer.login;
    const nodes = payload.data.search.nodes.filter((node) => node.__typename === 'PullRequest');

    return nodes.flatMap((node) => {
      const hasDirectOpenRequest = node.reviewRequests.nodes.some((request) => isViewerUser(request.requestedReviewer, viewer));
      const directEvents = node.timelineItems.nodes
        .filter((event) => event.__typename === 'ReviewRequestedEvent' && isViewerUser(event.requestedReviewer, viewer))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

      if (!hasDirectOpenRequest || directEvents.length === 0) {
        return [];
      }

      const repo = node.repository;
      return [{
        id: node.id,
        marker: directEvents.at(-1).createdAt,
        number: node.number,
        title: node.title,
        url: node.url,
        repository: { owner: repo.owner.login, repo: repo.name, nameWithOwner: repo.nameWithOwner },
      }];
    });
  }

  async getReviewContext(request) {
    const { owner, repo } = request.repository;
    const [files, issueComments, reviews, reviewComments, reviewThreads] = await Promise.all([
      this.#getJson(`repos/${owner}/${repo}/pulls/${request.number}/files`),
      this.#getJson(`repos/${owner}/${repo}/issues/${request.number}/comments`),
      this.#getJson(`repos/${owner}/${repo}/pulls/${request.number}/reviews`),
      this.#getJson(`repos/${owner}/${repo}/pulls/${request.number}/comments`),
      this.#getReviewThreads(owner, repo, request.number),
    ]);

    return {
      pullRequest: request,
      changedFiles: files.map((file) => ({ path: file.filename, patch: file.patch ?? '', additions: parseAddedLines(file.patch ?? '') })),
      issueComments: issueComments.map((comment) => ({ author: comment.user?.login ?? 'unknown', body: comment.body ?? '' })),
      reviews: reviews.map((review) => ({ author: review.user?.login ?? 'unknown', state: review.state ?? 'UNKNOWN', body: review.body ?? '' })),
      reviewComments: reviewComments.map((comment) => ({ author: comment.user?.login ?? 'unknown', path: comment.path, line: comment.line ?? comment.original_line, body: comment.body ?? '' })),
      reviewThreads,
    };
  }

  buildPrompt(context) {
    const fileSections = context.changedFiles.map((file) => `### ${file.path}\n${file.patch || '(no patch available)'}`).join('\n\n');
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
- Use Critical for production-breaking correctness/security/data-loss blockers.
- Use Important for defects that should block merge.
- Use Suggestion only for non-blocking improvements.
- Anchor findings to added lines in the diff whenever possible.

## Existing issue comments
${issueComments}

## Existing reviews
${reviews}

## Existing inline review comments
${reviewComments}

## Existing review threads and replies
${reviewThreads}

## Diff
${fileSections}
`;
  }

  async submitReview(request, decision) {
    const { owner, repo } = request.repository;
    const body = JSON.stringify({ event: decision.event, body: decision.body, comments: decision.comments });
    await this.execGh([`repos/${owner}/${repo}/pulls/${request.number}/reviews`, '-X', 'POST', '--input', '-'], body);
  }

  async #getJson(path) {
    return JSON.parse(await this.execGh([path]));
  }

  async #getReviewThreads(owner, repo, number) {
    const query = `
query {
  repository(owner: "${escapeGraphql(owner)}", name: "${escapeGraphql(repo)}") {
    pullRequest(number: ${number}) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          path
          line
          comments(first: 100) { nodes { author { login } body } }
        }
      }
    }
  }
}`;
    const payload = JSON.parse(await this.execGh(['graphql'], query));
    const nodes = payload.data.repository.pullRequest.reviewThreads.nodes;
    return nodes.map((thread) => ({
      path: thread.path,
      line: thread.line,
      isResolved: thread.isResolved,
      comments: thread.comments.nodes.map((comment) => ({ author: comment.author?.login ?? 'unknown', body: comment.body ?? '' })),
    }));
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

function isViewerUser(requestedReviewer, viewer) {
  return requestedReviewer?.__typename === 'User' && requestedReviewer.login === viewer;
}

function formatEntries(entries, formatter) {
  if (entries.length === 0) {
    return '(none)';
  }
  return entries.map(formatter).join('\n');
}

function escapeGraphql(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function defaultExecGh(args, input) {
  const ghArgs = args[0] === 'graphql' ? ['api', 'graphql', '-f', `query=${input ?? ''}`] : ['api', ...args];
  const stdin = args[0] === 'graphql' ? undefined : input;
  return runProcess('gh', ghArgs, stdin);
}

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr}`));
      }
    });
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

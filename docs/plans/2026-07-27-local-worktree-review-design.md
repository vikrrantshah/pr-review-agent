# Local Worktree Review Design

## Problem

The current reviewer depends on GitHub API patch data. For very large pull requests, GitHub omits some file patches and can reject the fallback full diff with HTTP 406 once the diff exceeds 20,000 lines. The agent then either loses patch context or fails the review.

## Decision

Use local worktree review for every PR.

The agent will still use GitHub APIs for review requests, comments, existing reviews, review threads, and review submission. Diff and file inspection will move to a local checkout so `pi` can review the real PR files instead of only API patch text.

## Architecture

Add a local checkout component responsible for one PR at a time:

1. Create an isolated temporary worktree path.
2. Fetch the PR base and head refs.
3. Check out the PR head in the worktree.
4. Generate a local diff from base to head.
5. Return the worktree path and parsed changed files.
6. Clean up the worktree after review success or failure.

Update `PiAdapter` so `review(prompt, { cwd })` can run `pi` from the PR worktree. Update `runProcess` to accept `cwd` and pass it to `spawn`.

Keep `GitHubAdapter` as the owner of GitHub metadata and review submission. It should no longer need GitHub's PR diff endpoint for normal operation once local diff generation is in place.

## Data Flow

```text
review request
  -> GitHub metadata fetch
  -> local worktree checkout
  -> local git diff parse
  -> build prompt with comments, reviews, threads, and local diff
  -> run pi in worktree cwd
  -> format review decision
  -> submit review via GitHub API
  -> cleanup worktree
```

## Error Handling

- Worktree creation/fetch failures fail that PR review and leave other PRs running.
- Cleanup runs in `finally`; cleanup errors are logged but do not hide the original review error.
- Existing duplicate-review protection stays unchanged.
- The current GitHub oversized-diff fallback can remain as a temporary backup until local review is proven.

## Concurrency

Each PR gets a unique worktree directory derived from repository owner, repo, PR number, and a random suffix. This avoids collisions when reviews run concurrently.

## Testing

Add unit coverage for:

- `runProcess` passes `cwd` to `spawn`.
- `PiAdapter.review(prompt, { cwd })` passes `cwd` through.
- Local checkout creates a unique worktree path and cleans it up in success and failure paths.
- Local diff parsing preserves changed file paths, patches, and added line numbers.
- Orchestrator runs review with the PR worktree cwd and still submits through GitHub.

Smoke verification remains `pnpm test` for this repo. A manual smoke test can run one dry-run review against a large PR once credentials and repository access are available.

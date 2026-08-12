# PR Metadata in Review Logs

> Status: ready-for-agent

## Problem Statement

When the agent logs a review event, all I can see is the repo, PR number, title, and URL. When a batch of reviews fails, is blocked, or is skipped, I can't tell *who owns the PR* or *how long it has been waiting* without opening each URL in a browser. Other devs have complained that triaging the agent's output is slow: to figure out who to ping about a failed or stale review, I have to leave the logs and go dig around in GitHub.

## Solution

Enrich every PR-scoped log event (`review_started`, `review_completed`, `review_failed`, `review_skipped`) with:

- **Author** — the login of the person who opened the PR.
- **Age** — how long the review has been waiting, derived from when the review was requested.
- **Size** — lines added, lines removed, and number of files changed.

The human-facing pretty cards stay compact: they gain an `Author:` line and a humanized `Age:` line, inserted right after the existing timestamp line and before the title. The machine-facing JSON logs carry the full set (author, raw requested-at timestamp, and the three size counts) so downstream tooling can compute and filter on them.

This keeps triage in the logs: reading a single card tells me who to ping and whether the review is stale, without leaving the terminal.

## User Stories

1. As an agent operator, I want each review log event to show the PR author, so that I know who to contact about a review without opening the PR.
2. As an agent operator triaging failures, I want the author shown on `review_failed` events, so that I can immediately ping the right person when a review breaks.
3. As an agent operator, I want the author shown on `review_completed` events, so that I know whose PR was just approved or had changes requested.
4. As an agent operator, I want the author shown on `review_started` events, so that I can see whose PR the agent is currently working on.
5. As an agent operator, I want the author shown on `review_skipped` events, so that I understand whose already-handled PR was passed over.
6. As an agent operator, I want to see how long a PR has been waiting for review, so that I can prioritize the stalest ones.
7. As an agent operator, I want the waiting time rendered in human terms (e.g. "waiting 3d 4h"), so that I can judge staleness at a glance without doing date math.
8. As an agent operator scanning a wall of pretty cards, I want author and age shown compactly near the top of each card, so that I can triage quickly.
9. As an operator wiring the agent's output into other tooling, I want the JSON logs to carry the PR author, so that I can group or route events by author.
10. As an operator building dashboards, I want the JSON logs to carry the raw requested-at timestamp, so that I can compute age myself and filter on arbitrary thresholds.
11. As an operator building dashboards, I want the JSON logs to carry lines added, lines removed, and files changed, so that I can spot oversized PRs and correlate review outcomes with PR size.
12. As an agent operator, I want the size counts kept out of the pretty cards, so that the cards stay compact and readable.
13. As an agent operator, I want a PR with a missing or deleted author to log a sensible placeholder rather than crash or show blank, so that the log stream never breaks on edge cases.
14. As an agent operator, I want the age line omitted entirely when the requested-at time is unavailable, so that I never see a bogus or negative duration.
15. As an agent operator, I want a PR whose size counts are unavailable to default to zero, so that the event shape stays consistent.
16. As an agent operator, I do not want the author echoed into the review comment posted to GitHub, so that reviews stay clean and non-redundant (GitHub already shows the author).
17. As an agent operator, I want the new metadata gathered without any extra API calls, so that adding it does not slow down polling or risk new rate-limit pressure.
18. As a maintainer, I want the metadata to ride on the existing event object, so that the JSON logger picks it up automatically without bespoke serialization.

## Implementation Decisions

- **Modules modified:** the GitHub adapter (data extraction), the orchestrator (event plumbing), and the loggers (pretty rendering). No new module.
- **Data source — single existing query, no extra calls.** The personal-review-request listing already issues one GraphQL query per PR page. `author { login }`, `additions`, `deletions`, and `changedFiles` are added to that same PullRequest selection. The review-requested timestamp is already available from the timeline event that builds the review marker, so no new fetch is needed.
- **Review request shape is extended.** The request object returned by the review-request listing gains: `author` (login string), `requestedAt` (ISO-8601 string, the time the review was requested), `additions` (int), `deletions` (int), `changedFiles` (int).
- **Fallbacks are explicit.** Author falls back to `unknown` (reusing the codebase's existing login-or-unknown convention) when the PR author is null/deleted. `additions`/`deletions`/`changedFiles` default to `0` when absent. `requestedAt` may be absent; consumers must tolerate that.
- **Events carry the metadata.** The orchestrator's PR-scoped log-event builder spreads `author`, `requestedAt`, `additions`, `deletions`, and `changedFiles` from the request onto every PR-scoped event (`review_started`, `review_completed`, `review_failed`, `review_skipped`).
- **JSON logger is unchanged by design.** It already serializes the entire event object, so the new fields appear in JSON output automatically.
- **Pretty cards gain two lines.** For each PR-scoped card, an `Author:` line and an `Age:` line are inserted after the timestamp line and before the title. Age is computed as `event timestamp − requestedAt` and humanized to a coarse "waiting Xd Yh" / "waiting Xh" / "waiting <1h" form. If `requestedAt` is missing, the `Age:` line is omitted rather than shown with a placeholder.
- **Size stays JSON-only.** `additions`/`deletions`/`changedFiles` are not rendered in the pretty cards.
- **The posted GitHub review body is untouched.** This change is confined to the agent's own logs; nothing about author or metadata is added to the review submitted to the PR.

## Testing Decisions

- **What makes a good test here:** assert observable outputs at module boundaries, not internal wiring. For the GitHub adapter, that means feeding a mocked GraphQL/gh response and asserting the returned review request carries the expected fields (including fallbacks). For the loggers, that means passing an event object and asserting the rendered card text. For the orchestrator, that means asserting the shape of the events handed to the injected logger. No test should reach into private helpers or assert on humanization internals beyond the produced strings.
- **GitHub adapter (existing `execGh` seam):** extend the personal-review-request tests to assert the returned request includes `author`, `requestedAt`, `additions`, `deletions`, `changedFiles`, and that a null author maps to `unknown` and missing counts default to `0`. This is the primary seam for the extraction behavior.
- **Loggers (existing `formatPrettyEvent` pure-function seam):** add tests that a PR-scoped event with `author` and `requestedAt` renders an `Author:` line and a humanized `Age:` line in the expected position; that a missing `requestedAt` omits the `Age:` line; and that size counts do not appear in the card. This is the primary seam for the rendering behavior.
- **Orchestrator (existing injected-logger seam):** extend the existing "emits review events" assertions to confirm the new fields ride along on the emitted events. This is thin plumbing coverage, not new logic.
- **Prior art:** the existing GitHub adapter tests that drive `listPersonalReviewRequests` via a mocked `execGh`; the existing logger tests that call `formatPrettyEvent` directly and assert on card text; and the existing orchestrator tests that inject a capturing logger and assert emitted event shapes.

## Out of Scope

- Adding author or any metadata to the review body posted to GitHub (logs only — see decision above).
- Any additional GitHub API calls or new endpoints to gather metadata.
- Additional fields not chosen for this iteration: base branch, head SHA, draft status, and labels.
- Rendering size counts in the pretty cards (JSON-only by decision).
- Changing the approve/request-changes decision logic or the severity model.
- Configurability of which fields appear or of the age-humanization format.
- Localization/timezone handling of the humanized age beyond the coarse day/hour form.

## Further Notes

- All new fields are available from the one GraphQL query the listing already performs, so this is a low-risk, no-extra-cost enrichment.
- This follows the earlier reliability and leniency fixes (Codex usage-limit fallback, larger git timeout with safe worktree cleanup, and Critical-only merge blocking); making failed and blocked reviews easier to attribute is the natural operational follow-up.
- The humanized age is intentionally coarse (days/hours). If finer buckets or an absolute "requested at" line in the pretty card are wanted later, they can be layered on without changing the event shape, since JSON already carries the raw `requestedAt`.

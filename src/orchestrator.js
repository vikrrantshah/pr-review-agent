import { formatReviewDecision, parseReviewResult } from './review-result.js';

const FAILURE_RETRY_MS = 15 * 60 * 1000;

export class Orchestrator {
  constructor({ github, pi, state, localReview, dryRun = false, concurrency = 3, logger = console } = {}) {
    this.github = github;
    this.pi = pi;
    this.state = state;
    this.localReview = localReview;
    this.dryRun = dryRun;
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.logger = logger;
    this.failedUntil = new Map();
    this.running = false;
  }

  async runTick() {
    if (this.running) {
      return { reviewed: 0, skipped: 0, failed: 0, overlapped: true };
    }

    this.running = true;
    try {
      return await this.#runTickUnlocked();
    } finally {
      this.running = false;
    }
  }

  async #runTickUnlocked() {
    const summary = { reviewed: 0, skipped: 0, failed: 0, overlapped: false };
    let requests;
    try {
      requests = await this.github.listPersonalReviewRequests();
    } catch (error) {
      summary.failed += 1;
      this.#log({ event: 'poll_failed', error: error.message });
      return summary;
    }

    let index = 0;
    const workerCount = Math.min(this.concurrency, requests.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (index < requests.length) {
        const request = requests[index];
        index += 1;
        await this.#reviewRequest(request, summary);
      }
    });
    await Promise.all(workers);

    return summary;
  }

  async #reviewRequest(request, summary) {
    if (await this.state.isHandled(request.id, request.marker)) {
      summary.skipped += 1;
      this.#log(reviewLogEvent('review_skipped', request, { reason: 'already_handled' }));
      return;
    }

    const key = reviewKey(request);
    const retryAt = this.failedUntil.get(key);
    if (retryAt && retryAt > Date.now()) {
      summary.skipped += 1;
      return;
    }
    this.failedUntil.delete(key);

    let submitted = false;
    try {
      if (!this.dryRun && this.github.hasSubmittedReview && await this.github.hasSubmittedReview(request)) {
        await this.state.markHandled(request.id, request.marker);
        summary.skipped += 1;
        this.#log(reviewLogEvent('review_skipped', request, { reason: 'already_submitted' }));
        return;
      }
      this.#log(reviewLogEvent('review_started', request));
      const metadata = await this.github.getReviewContext(request);
      const { decision, counts } = await this.localReview.withCheckout(request, async (checkout) => {
        const context = { ...metadata, changedFiles: checkout.changedFiles };
        const prompt = this.github.buildPrompt(context);
        const result = parseReviewResult(await this.pi.review(prompt, { cwd: checkout.cwd }));
        return {
          decision: formatReviewDecision({ findings: result.findings, changedFiles: context.changedFiles }),
          counts: countFindings(result.findings),
        };
      });

      if (!this.dryRun) {
        await this.github.submitReview(request, decision);
        submitted = true;
        await this.state.markHandled(request.id, request.marker);
      }
      summary.reviewed += 1;
      this.#log(reviewLogEvent('review_completed', request, {
        ...counts,
        commentsPosted: this.dryRun ? 0 : decision.comments.length,
        action: reviewAction(decision.event, this.dryRun),
      }));
    } catch (error) {
      if (!submitted) {
        this.failedUntil.set(key, Date.now() + FAILURE_RETRY_MS);
      }
      summary.failed += 1;
      this.#log(reviewLogEvent('review_failed', request, { error: error.message }));
    }
  }

  #log(event) {
    const payload = { timestamp: new Date().toISOString(), ...event };
    if (typeof this.logger.logEvent === 'function') {
      this.logger.logEvent(payload);
      return;
    }
    this.logger.log(JSON.stringify(payload));
  }

  startPolling(intervalMs) {
    const timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
    void this.runTick();
    return timer;
  }
}

function reviewLogEvent(event, request, details = {}) {
  return {
    event,
    repo: request.repository.nameWithOwner,
    number: request.number,
    title: request.title,
    url: request.url,
    ...details,
  };
}

function reviewKey(request) {
  return `${request.id}:${request.marker}`;
}

function countFindings(findings) {
  const counts = { critical: 0, important: 0, suggestions: 0 };
  for (const finding of findings) {
    if (finding.severity === 'Critical') counts.critical += 1;
    else if (finding.severity === 'Important') counts.important += 1;
    else if (finding.severity === 'Suggestion') counts.suggestions += 1;
  }
  return counts;
}

function reviewAction(event, dryRun) {
  if (dryRun) {
    return event === 'APPROVE' ? 'would_approve' : 'would_request_changes';
  }
  return event === 'APPROVE' ? 'approved' : 'request_changes';
}

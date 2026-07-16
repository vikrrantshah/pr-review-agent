import { formatReviewDecision, parseReviewResult } from './review-result.js';

export class Orchestrator {
  constructor({ github, pi, state, dryRun = false, concurrency = 3 }) {
    this.github = github;
    this.pi = pi;
    this.state = state;
    this.dryRun = dryRun;
    this.concurrency = Math.max(1, Math.floor(concurrency));
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
      return;
    }

    try {
      if (!this.dryRun && this.github.hasSubmittedReview && await this.github.hasSubmittedReview(request)) {
        await this.state.markHandled(request.id, request.marker);
        summary.skipped += 1;
        return;
      }
      const context = await this.github.getReviewContext(request);
      const prompt = this.github.buildPrompt(context);
      const result = parseReviewResult(await this.pi.review(prompt));
      const decision = formatReviewDecision({ findings: result.findings, changedFiles: context.changedFiles });

      if (!this.dryRun) {
        await this.github.submitReview(request, decision);
        await this.state.markHandled(request.id, request.marker);
      }
      summary.reviewed += 1;
    } catch (error) {
      summary.failed += 1;
    }
  }

  startPolling(intervalMs) {
    const timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
    void this.runTick();
    return timer;
  }
}

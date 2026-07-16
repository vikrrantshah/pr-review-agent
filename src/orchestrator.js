import { formatReviewDecision, parseReviewResult } from './review-result.js';

export class Orchestrator {
  constructor({ github, pi, state, dryRun = false }) {
    this.github = github;
    this.pi = pi;
    this.state = state;
    this.dryRun = dryRun;
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

    for (const request of requests) {
      if (await this.state.isHandled(request.id, request.marker)) {
        summary.skipped += 1;
        continue;
      }

      try {
        if (!this.dryRun && this.github.hasSubmittedReview && await this.github.hasSubmittedReview(request)) {
          await this.state.markHandled(request.id, request.marker);
          summary.skipped += 1;
          continue;
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

    return summary;
  }

  startPolling(intervalMs) {
    const timer = setInterval(() => {
      void this.runTick();
    }, intervalMs);
    void this.runTick();
    return timer;
  }
}

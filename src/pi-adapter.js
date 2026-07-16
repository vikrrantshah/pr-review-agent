import { runProcess } from './process-runner.js';

export const DEFAULT_PI_TIMEOUT_MS = 30 * 60 * 1000;
const PI_ARGS = ['--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh', '--no-session', '--print'];

export class PiAdapter {
  constructor({ run = runProcess, timeoutMs = DEFAULT_PI_TIMEOUT_MS } = {}) {
    this.run = run;
    this.timeoutMs = timeoutMs;
  }

  async review(prompt) {
    return this.run('pi', PI_ARGS, prompt, { timeoutMs: this.timeoutMs });
  }
}


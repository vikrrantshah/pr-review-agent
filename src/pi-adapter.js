import { DEFAULT_COMMAND_TIMEOUT_MS, runProcess } from './process-runner.js';

const PI_ARGS = ['--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh', '--no-session', '--print'];

export class PiAdapter {
  constructor({ run = runProcess, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this.run = run;
    this.timeoutMs = timeoutMs;
  }

  async review(prompt) {
    return this.run('pi', PI_ARGS, prompt, { timeoutMs: this.timeoutMs });
  }
}


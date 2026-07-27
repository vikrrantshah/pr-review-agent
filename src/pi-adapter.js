import { runProcess } from './process-runner.js';

export const DEFAULT_PI_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_PI_MODEL = 'openai-codex/gpt-5.5';
export const DEFAULT_PI_THINKING = 'xhigh';
const MODEL_ENV = 'PR_REVIEW_AGENT_PI_MODEL';
const THINKING_ENV = 'PR_REVIEW_AGENT_PI_THINKING';

export class PiAdapter {
  constructor({
    run = runProcess,
    timeoutMs = DEFAULT_PI_TIMEOUT_MS,
    model = configuredValue(process.env[MODEL_ENV], DEFAULT_PI_MODEL),
    thinking = configuredValue(process.env[THINKING_ENV], DEFAULT_PI_THINKING),
  } = {}) {
    this.run = run;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.thinking = thinking;
  }

  async review(prompt, { cwd } = {}) {
    return this.run('pi', this.#args(), prompt, { timeoutMs: this.timeoutMs, cwd });
  }

  #args() {
    const args = ['--model', this.model];
    if (this.thinking) {
      args.push('--thinking', this.thinking);
    }
    args.push('--no-session', '--print');
    return args;
  }
}

function configuredValue(value, fallback) {
  return value?.trim() ? value : fallback;
}


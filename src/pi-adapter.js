import { runProcess } from './process-runner.js';

export const DEFAULT_PI_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_PI_MODEL = 'openai-codex/gpt-5.5';
export const DEFAULT_PI_FALLBACK_MODEL = 'anthropic/claude-sonnet-4-5';
export const DEFAULT_PI_THINKING = 'xhigh';
const MODEL_ENV = 'PR_REVIEW_AGENT_PI_MODEL';
const FALLBACK_MODEL_ENV = 'PR_REVIEW_AGENT_PI_FALLBACK_MODEL';
const THINKING_ENV = 'PR_REVIEW_AGENT_PI_THINKING';
const USAGE_LIMIT_PATTERN = /usage limit|rate limit|quota|\b429\b/i;

export class PiAdapter {
  constructor({
    run = runProcess,
    timeoutMs = DEFAULT_PI_TIMEOUT_MS,
    model = configuredValue(process.env[MODEL_ENV], DEFAULT_PI_MODEL),
    fallbackModel = configuredValue(process.env[FALLBACK_MODEL_ENV], DEFAULT_PI_FALLBACK_MODEL),
    thinking = configuredValue(process.env[THINKING_ENV], DEFAULT_PI_THINKING),
  } = {}) {
    this.run = run;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.thinking = thinking;
  }

  async review(prompt, { cwd } = {}) {
    try {
      return await this.#runModel(this.model, prompt, cwd);
    } catch (error) {
      if (this.#canFallback(error)) {
        return this.#runModel(this.fallbackModel, prompt, cwd);
      }
      throw error;
    }
  }

  #canFallback(error) {
    return Boolean(this.fallbackModel)
      && this.fallbackModel !== this.model
      && isUsageLimitError(error);
  }

  #runModel(model, prompt, cwd) {
    return this.run('pi', this.#args(model), prompt, { timeoutMs: this.timeoutMs, cwd, requireStdout: true });
  }

  #args(model) {
    const args = ['--model', model];
    if (this.thinking) {
      args.push('--thinking', this.thinking);
    }
    args.push('--no-session', '--print');
    return args;
  }
}

function isUsageLimitError(error) {
  return USAGE_LIMIT_PATTERN.test(error?.message ?? '');
}

function configuredValue(value, fallback) {
  return value?.trim() ? value : fallback;
}

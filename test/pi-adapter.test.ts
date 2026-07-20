import { describe, expect, test } from 'vitest';
import { PiAdapter } from '../src/pi-adapter.js';

type RunOptions = { timeoutMs?: number };

describe('PiAdapter', () => {
  test('invokes Pi with the required model and print flags', async () => {
    const calls: { command: string; args: string[]; input: string; timeoutMs: number | undefined }[] = [];
    const adapter = new PiAdapter({
      run: async (command: string, args: string[], input: string, options?: RunOptions) => {
        calls.push({ command, args, input, timeoutMs: options?.timeoutMs });
        return '{"findings":[]}';
      },
    });

    const output = await adapter.review('prompt text');

    expect(output).toBe('{"findings":[]}');
    expect(calls).toEqual([
      {
        command: 'pi',
        args: ['--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh', '--no-session', '--print'],
        input: 'prompt text',
        timeoutMs: 30 * 60 * 1000,
      },
    ]);
  });
  test('uses Pi model and thinking from environment', async () => {
    const originalModel = process.env.PR_REVIEW_AGENT_PI_MODEL;
    const originalThinking = process.env.PR_REVIEW_AGENT_PI_THINKING;
    process.env.PR_REVIEW_AGENT_PI_MODEL = 'anthropic/claude-sonnet-4-5';
    process.env.PR_REVIEW_AGENT_PI_THINKING = 'high';
    const calls: { command: string; args: string[]; input: string; timeoutMs: number | undefined }[] = [];
    const adapter = new PiAdapter({
      run: async (command: string, args: string[], input: string, options?: RunOptions) => {
        calls.push({ command, args, input, timeoutMs: options?.timeoutMs });
        return '{"findings":[]}';
      },
    });

    try {
      await adapter.review('prompt text');
    } finally {
      restoreEnv('PR_REVIEW_AGENT_PI_MODEL', originalModel);
      restoreEnv('PR_REVIEW_AGENT_PI_THINKING', originalThinking);
    }

    expect(calls[0].args).toEqual(['--model', 'anthropic/claude-sonnet-4-5', '--thinking', 'high', '--no-session', '--print']);
  });

  test('uses explicit Pi options before environment defaults', async () => {
    const originalModel = process.env.PR_REVIEW_AGENT_PI_MODEL;
    process.env.PR_REVIEW_AGENT_PI_MODEL = 'anthropic/claude-sonnet-4-5';
    const calls: { args: string[] }[] = [];
    const adapter = new PiAdapter({
      model: 'openai-codex/gpt-5.5',
      thinking: 'xhigh',
      run: async (_command: string, args: string[]) => {
        calls.push({ args });
        return '{"findings":[]}';
      },
    });

    try {
      await adapter.review('prompt text');
    } finally {
      restoreEnv('PR_REVIEW_AGENT_PI_MODEL', originalModel);
    }

    expect(calls[0].args).toEqual(['--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh', '--no-session', '--print']);
  });
});

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

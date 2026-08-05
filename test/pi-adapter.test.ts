import { describe, expect, test } from 'vitest';
import { PiAdapter } from '../src/pi-adapter.js';

type RunOptions = { timeoutMs?: number; cwd?: string; requireStdout?: boolean };

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
        timeoutMs: 60 * 60 * 1000,
      },
    ]);
  });

  test('passes cwd to Pi run options', async () => {
    const calls: { cwd: string | undefined }[] = [];
    const adapter = new PiAdapter({
      run: async (_command: string, _args: string[], _input: string, options?: RunOptions) => {
        calls.push({ cwd: options?.cwd });
        return '{"findings":[]}';
      },
    });

    await adapter.review('prompt', { cwd: '/tmp/pr-worktree' });

    expect(calls).toEqual([{ cwd: '/tmp/pr-worktree' }]);
  });

  test('requires Pi stdout so empty successful runs include stderr', async () => {
    const calls: { requireStdout: boolean | undefined }[] = [];
    const adapter = new PiAdapter({
      run: async (_command: string, _args: string[], _input: string, options?: RunOptions) => {
        calls.push({ requireStdout: options?.requireStdout });
        return '{"findings":[]}';
      },
    });

    await adapter.review('prompt');

    expect(calls).toEqual([{ requireStdout: true }]);
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

  test('falls back to the secondary model when the primary hits a usage limit', async () => {
    const calls: { args: string[] }[] = [];
    const adapter = new PiAdapter({
      model: 'openai-codex/gpt-5.5',
      fallbackModel: 'anthropic/claude-sonnet-4-5',
      run: async (_command: string, args: string[]) => {
        calls.push({ args });
        if (calls.length === 1) {
          throw new Error('pi exited with 1: Codex error: The usage limit has been reached');
        }
        return '{"findings":[]}';
      },
    });

    const output = await adapter.review('prompt text');

    expect(output).toBe('{"findings":[]}');
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['--model', 'openai-codex/gpt-5.5', '--thinking', 'xhigh', '--no-session', '--print']);
    expect(calls[1].args).toEqual(['--model', 'anthropic/claude-sonnet-4-5', '--thinking', 'xhigh', '--no-session', '--print']);
  });

  test('does not fall back for non usage-limit errors', async () => {
    const calls: { args: string[] }[] = [];
    const adapter = new PiAdapter({
      model: 'openai-codex/gpt-5.5',
      fallbackModel: 'anthropic/claude-sonnet-4-5',
      run: async (_command: string, args: string[]) => {
        calls.push({ args });
        throw new Error('pi exited with 1: some other failure');
      },
    });

    await expect(adapter.review('prompt text')).rejects.toThrow('some other failure');
    expect(calls).toHaveLength(1);
  });

  test('does not fall back when the fallback matches the primary model', async () => {
    const calls: { args: string[] }[] = [];
    const adapter = new PiAdapter({
      model: 'openai-codex/gpt-5.5',
      fallbackModel: 'openai-codex/gpt-5.5',
      run: async (_command: string, args: string[]) => {
        calls.push({ args });
        throw new Error('pi exited with 1: Codex error: The usage limit has been reached');
      },
    });

    await expect(adapter.review('prompt text')).rejects.toThrow('usage limit');
    expect(calls).toHaveLength(1);
  });

  test('uses the fallback model from environment', async () => {
    const originalFallback = process.env.PR_REVIEW_AGENT_PI_FALLBACK_MODEL;
    process.env.PR_REVIEW_AGENT_PI_FALLBACK_MODEL = 'anthropic/claude-opus-4-8';
    const calls: { args: string[] }[] = [];
    const adapter = new PiAdapter({
      model: 'openai-codex/gpt-5.5',
      run: async (_command: string, args: string[]) => {
        calls.push({ args });
        if (calls.length === 1) {
          throw new Error('pi exited with 1: Codex error: The usage limit has been reached');
        }
        return '{"findings":[]}';
      },
    });

    try {
      await adapter.review('prompt text');
    } finally {
      restoreEnv('PR_REVIEW_AGENT_PI_FALLBACK_MODEL', originalFallback);
    }

    expect(calls[1].args).toEqual(['--model', 'anthropic/claude-opus-4-8', '--thinking', 'xhigh', '--no-session', '--print']);
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

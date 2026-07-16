import { describe, expect, test } from 'vitest';
import { PiAdapter } from '../src/pi-adapter.js';

describe('PiAdapter', () => {
  test('invokes Pi with the required model and print flags', async () => {
    const calls: { command: string; args: string[]; input: string }[] = [];
    const adapter = new PiAdapter({
      run: async (command, args, input) => {
        calls.push({ command, args, input });
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
      },
    ]);
  });
});

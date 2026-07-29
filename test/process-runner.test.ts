import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runProcess } from '../src/process-runner.js';

describe('runProcess', () => {
  test('runs a command from the requested working directory', async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pr-review-agent-cwd-')));
    const stdout = await runProcess(process.execPath, ['-e', 'console.log(process.cwd())'], undefined, { cwd });

    expect(stdout.trim()).toBe(cwd);
  });

  test('merges supplied environment variables into the spawn environment', async () => {
    const envName = `PR_REVIEW_AGENT_ENV_${Date.now()}`;
    const script = `console.log([process.env[${JSON.stringify(envName)}], Boolean(process.env.PATH)].join(':'))`;

    const stdout = await runProcess(process.execPath, ['-e', script], undefined, { env: { [envName]: 'merged' } });

    expect(stdout.trim()).toBe('merged:true');
  });

  test('surfaces stderr when stdout is required but empty', async () => {
    const script = "console.error('provider auth missing')";

    await expect(runProcess(process.execPath, ['-e', script], undefined, { requireStdout: true })).rejects.toThrow('provider auth missing');
  });

  test('terminates a command that exceeds its timeout', async () => {
    // Integration check: a spawned OS process needs the platform clock to verify cancellation.
    const startedAt = Date.now();
    await expect(runProcess(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);'], undefined, { timeoutMs: 25 })).rejects.toThrow(/timed out/i);

    expect(Date.now() - startedAt).toBeLessThan(800);
  });
});

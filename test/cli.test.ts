import { describe, expect, test } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  test('ignores pnpm argument separator', () => {
    expect(parseArgs(['--dry-run', '--', '--once'])).toEqual({ dryRun: true, once: true, intervalMs: 60_000, concurrency: 3, logFormat: 'pretty' });
  });

  test('accepts a custom concurrency limit', () => {
    expect(parseArgs(['--concurrency', '5'])).toEqual({ dryRun: false, once: false, intervalMs: 60_000, concurrency: 5, logFormat: 'pretty' });
  });

  test('accepts JSON log output for machine-readable logs', () => {
    expect(parseArgs(['--log-format', 'json'])).toEqual({ dryRun: false, once: false, intervalMs: 60_000, concurrency: 3, logFormat: 'json' });
  });
});

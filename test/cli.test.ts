import { describe, expect, test } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  test('ignores pnpm argument separator', () => {
    expect(parseArgs(['--dry-run', '--', '--once'])).toEqual({ dryRun: true, once: true, intervalMs: 60_000, concurrency: 3 });
  });

  test('accepts a custom concurrency limit', () => {
    expect(parseArgs(['--concurrency', '5'])).toEqual({ dryRun: false, once: false, intervalMs: 60_000, concurrency: 5 });
  });
});

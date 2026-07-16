import { describe, expect, test } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  test('ignores pnpm argument separator', () => {
    expect(parseArgs(['--dry-run', '--', '--once'])).toEqual({ dryRun: true, once: true, intervalMs: 60_000 });
  });
});

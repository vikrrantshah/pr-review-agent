import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { StateStore } from '../src/state-store.js';

const dirs: string[] = [];

async function tempStatePath() {
  const dir = await mkdtemp(join(tmpdir(), 'pr-review-agent-state-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('StateStore', () => {
  test('skips the same review-request marker and allows a new marker', async () => {
    const store = new StateStore(await tempStatePath());

    expect(await store.isHandled('PR_kwDO1', '2026-07-15T10:00:00Z')).toBe(false);

    await store.markHandled('PR_kwDO1', '2026-07-15T10:00:00Z');

    expect(await store.isHandled('PR_kwDO1', '2026-07-15T10:00:00Z')).toBe(true);
    expect(await store.isHandled('PR_kwDO1', '2026-07-16T10:00:00Z')).toBe(false);
  });

  test('uses the user cache directory by default', () => {
    expect(StateStore.defaultPath()).toMatch(/\.cache\/pr-review-agent\/state\.json$/);
  });
});

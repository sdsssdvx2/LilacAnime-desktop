import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state.mjs';

test('resolved title aliases persist and restore companion season context', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilac-companion-state-'));
  const file = path.join(dir, 'state.json');
  try {
    const first = await new StateStore(file).load();
    const anime = {
      provider: 'reanime',
      id: 'sword-of-coming',
      title: 'Sword of Coming',
      companionSeasonNumber: 1
    };
    await first.rememberTitleAliases(anime, ['검래', 'Jian Lai']);

    const second = await new StateStore(file).load();
    const restoredAnime = { provider: 'reanime', id: 'sword-of-coming', title: 'Sword of Coming' };
    const aliases = second.titleAliases(restoredAnime);
    assert.ok(aliases.includes('검래'));
    assert.ok(aliases.includes('Jian Lai'));
    assert.equal(restoredAnime.companionSeasonNumber, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

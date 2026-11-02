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

test('rememberSubtitle skips an identical subtitle preference instead of rewriting state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilac-companion-state-'));
  const file = path.join(dir, 'state.json');
  try {
    const state = await new StateStore(file).load();
    const anime = { provider: 'miruro', id: 'bleach', title: 'Bleach' };
    const subtitle = { path: 'C:\\Subs\\Bleach_-_001.sync.vtt', kind: 'user' };
    assert.equal(await state.rememberSubtitle(anime, 1, subtitle), true);
    const first = JSON.parse(await fs.readFile(file, 'utf8'));
    const firstRecord = first.subtitlePreferences['miruro:bleach']['1'];

    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await state.rememberSubtitle(anime, 1, subtitle), false);
    const second = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(second.subtitlePreferences['miruro:bleach']['1'].updatedAt, firstRecord.updatedAt);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

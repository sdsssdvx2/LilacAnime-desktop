import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePlaybackSessionKey } from '../src/source/playback-session.mjs';

const context = (entry, provider = 'reanime', activePlayer = true) =>
  ({ episode: { number: 1, provider }, playbackSessionId: entry, activePlayer });

test('an exited player has no active diagnostic session', () => {
  const before = sourcePlaybackSessionKey('anime:100|1', context(10));
  const exited = sourcePlaybackSessionKey('anime:100|1', context(10, 'reanime', false));
  assert.ok(before);
  assert.equal(exited, '');
});

test('re-entering the same episode after exit starts a new diagnostic session', () => {
  const original = sourcePlaybackSessionKey('anime:100|1', context(10));
  const returned = sourcePlaybackSessionKey('anime:100|1', context(11));
  assert.notEqual(original, returned);
  assert.equal(original, sourcePlaybackSessionKey('anime:100|1', context(10)));
});

test('new provider, anime or episode cannot be mistaken for in-flight original playback', () => {
  const base = sourcePlaybackSessionKey('anime:100|1', context(10));
  assert.notEqual(base, sourcePlaybackSessionKey('anime:100|1', context(10, 'miruro')));
  assert.notEqual(base, sourcePlaybackSessionKey('anime:100|2', context(10)));
  assert.notEqual(base, sourcePlaybackSessionKey('anime:101|1', context(10)));
});

test('a session requires a valid provider and current active player', () => {
  assert.equal(sourcePlaybackSessionKey('', context(1)), '');
  assert.equal(sourcePlaybackSessionKey('anime:100|1', context(1, '')), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { withinSourceSwitchWindow } from '../src/source/switch-window.mjs';

test('late source switch window is based on entry wall time, not media position', () => {
  assert.equal(withinSourceSwitchWindow(1_000, { now: 120_999, maxSeconds: 120 }), true);
  assert.equal(withinSourceSwitchWindow(1_000, { now: 121_001, maxSeconds: 120 }), false);
});

test('missing entry timestamp never authorizes a late switch', () => {
  assert.equal(withinSourceSwitchWindow(0, { now: 5_000, maxSeconds: 120 }), false);
});

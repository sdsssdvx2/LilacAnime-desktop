'use strict';

const assert = require('node:assert/strict');

const SOURCE_FPS = 23.976;
const DISPLAY_HZ = 144;
const DURATION_MS = 10000;
const SOURCE_INTERVAL = 1000 / SOURCE_FPS;
const VSYNC = 1000 / DISPLAY_HZ;

function simulate({ warm }) {
  let now = 0;
  let nextSource = 0;
  let nextRaf = Infinity;
  let loopActive = false;
  let latestFrame = 0;
  let presentedFrame = 0;
  let received = 0;
  let presented = 0;
  let coalesced = 0;
  const presentTimes = [];

  const requestColdRaf = at => Math.ceil((at + 43) / VSYNC) * VSYNC;
  const requestWarmRaf = at => Math.ceil((at + 0.001) / VSYNC) * VSYNC;

  while (now <= DURATION_MS + 100) {
    const eventAt = Math.min(nextSource, nextRaf);
    if (!Number.isFinite(eventAt)) break;
    now = eventAt;
    if (nextSource <= nextRaf) {
      received += 1;
      const frameId = received;
      if (latestFrame && latestFrame !== presentedFrame) coalesced += 1;
      latestFrame = frameId;
      if (!loopActive) {
        loopActive = true;
        nextRaf = warm ? requestWarmRaf(now) : requestColdRaf(now);
      }
      nextSource += SOURCE_INTERVAL;
      if (nextSource > DURATION_MS) nextSource = Infinity;
    } else {
      if (latestFrame && latestFrame !== presentedFrame) {
        presentedFrame = latestFrame;
        presented += 1;
        presentTimes.push(now);
      }
      if (warm && (now < DURATION_MS || latestFrame !== presentedFrame)) {
        nextRaf = requestWarmRaf(now);
      } else {
        loopActive = false;
        nextRaf = Infinity;
      }
    }
  }

  const span = presentTimes.length > 1 ? presentTimes.at(-1) - presentTimes[0] : 0;
  const fps = span > 0 ? (presentTimes.length - 1) * 1000 / span : 0;
  return { received, presented, coalesced, fps };
}

const cold = simulate({ warm: false });
const warm = simulate({ warm: true });
assert.ok(cold.presented < cold.received * 0.9, `cold one-shot model should coalesce heavily: ${JSON.stringify(cold)}`);
assert.ok(warm.presented >= warm.received - 1, `warm rAF loop should preserve source frames: ${JSON.stringify(warm)}`);
assert.ok(warm.coalesced <= 1, `warm rAF loop should nearly eliminate coalescing: ${JSON.stringify(warm)}`);
assert.ok(Math.abs(warm.fps - SOURCE_FPS) < 0.2, `warm rAF cadence should track source fps: ${JSON.stringify(warm)}`);

console.log(`LIBMPV_R2Y_PRESENT_LOOP_SIM_REPORT=${JSON.stringify({cold,warm,sourceFps:SOURCE_FPS,displayHz:DISPLAY_HZ})}`);
console.log('LIBMPV_R2Y_PRESENT_LOOP_SIM_OK');

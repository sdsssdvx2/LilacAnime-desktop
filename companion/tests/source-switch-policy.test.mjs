import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBestSource, safeAutoSwitchDecision } from '../src/source/scout.mjs';
import { allowQuickAutoSwitch } from '../src/source/quick-switch.mjs';

const source = (provider, height, bitrate, stability, failureRate = 0, mappingConfidence = 'high', codecs = '') => ({
  provider,
  ok: true,
  value: {
    provider,
    mappingConfidence,
    probe: {
      quality: { height, width: height ? Math.round(height * 16 / 9) : null, bandwidth: bitrate, codecs },
      metrics: { stability, failureRate }
    }
  }
});

test('strong bitrate win can auto-switch from 804p to 720p without visual alignment', () => {
  const results = [
    source('reanime', 804, 1_500_000, 96),
    source('miruro', 720, 3_000_000, 98)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const safety = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(scan.decision.selected?.provider, 'miruro');
  assert.equal(safety.switch, true);
  assert.equal(safety.reason, 'decisive-bitrate-quality-win');
  assert.equal(allowQuickAutoSwitch(scan, safety), true);
});

test('modest bitrate win between near resolutions still waits for visual evidence', () => {
  const results = [
    source('reanime', 804, 2_300_000, 98),
    source('miruro', 720, 2_900_000, 99)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const safety = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(safety.switch, false);
  assert.equal(allowQuickAutoSwitch(scan, safety), false);
});

test('quick switch refuses decisive quality evidence when winner stability is below 90', () => {
  const results = [
    source('reanime', 720, 2_000_000, 82),
    source('miruro', 1080, 5_000_000, 88)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const safety = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(safety.switch, true);
  assert.equal(safety.reason, 'clear-resolution-win');
  assert.equal(allowQuickAutoSwitch(scan, safety), false);
});

test('quick switch accepts stable clear resolution win', () => {
  const results = [
    source('reanime', 720, 3_000_000, 95),
    source('miruro', 1080, 5_000_000, 94)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const safety = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(safety.switch, true);
  assert.equal(allowQuickAutoSwitch(scan, safety), true);
});

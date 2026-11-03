import test from 'node:test';
import assert from 'node:assert/strict';
import { lilacRecoveryAction } from '../src/lilac/lifecycle.mjs';

test('Companion may launch Lilac only before the first successful connection', () => {
  assert.equal(lilacRecoveryAction({ everConnected: false, lilacRunning: false }), 'allow-initial-launch');
});

test('Companion exits after a previously connected Lilac process is closed', () => {
  assert.equal(lilacRecoveryAction({ everConnected: true, lilacRunning: false }), 'exit');
});

test('Companion retries CDP attach without relaunch when Lilac is still running', () => {
  assert.equal(lilacRecoveryAction({ everConnected: true, lilacRunning: true }), 'reattach-only');
});

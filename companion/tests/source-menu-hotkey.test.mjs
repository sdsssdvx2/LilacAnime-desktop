import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { listenForSourceManager, launchSourceManager } from '../src/source/source-menu-hotkey.mjs';

test('typing 1 + Enter opens source manager, other inputs do nothing', () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setEncoding = () => {};
  input.resume = () => {};
  let opened = 0;
  const logs = [];
  const stop = listenForSourceManager({
    input, open: () => { opened++; }, log: value => logs.push(value)
  });
  input.emit('data', 'hello\r\n');
  input.emit('data', '1');
  assert.equal(opened, 0);
  input.emit('data', '\r\n');
  assert.equal(opened, 1);
  stop();
  input.emit('data', '1\r\n');
  assert.equal(opened, 1);
  assert.match(logs.join(' '), /1 입력 후 Enter/);
});

test('noninteractive watch retains automatic operation and offers menu shortcut', () => {
  const input = new EventEmitter();
  input.isTTY = false;
  const logs = [];
  const stop = listenForSourceManager({
    input, open: () => assert.fail('No interactive input'), log: msg => logs.push(msg)
  });
  input.emit('data', '1\r\n');
  stop();
  assert.match(logs.join(' '), /시작 메뉴/);
});

test('Windows launcher starts own console, not inherited stdin/stdout, with quoted path', () => {
  const calls = [];
  const fakeSpawn = (exe, args, options) => {
    calls.push({ exe, args, options });
    return { on() {}, unref() {} };
  };
  launchSourceManager({
    exe: "C:\\Program Files\\Lilac's Companion\\LilacCompanion.exe",
    packaged: true, platform: 'win32', spawnProcess: fakeSpawn
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'powershell.exe');
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  const command = calls[0].args.at(-1);
  assert.match(command, /Start-Process/);
  assert.match(command, /Lilac''s Companion/);
  assert.match(command, /sources/);
  assert.match(command, /menu/);
});

test('non-Windows direct source-manager launcher fails clearly', () => {
  assert.throws(() => launchSourceManager({ platform: 'linux' }), /requires Windows/);
});

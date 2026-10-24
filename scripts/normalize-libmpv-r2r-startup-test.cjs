'use strict';
const fs = require('node:fs');
const path = require('node:path');
const file = path.resolve(__dirname, '..', 'tests', 'startup.test.cjs');
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  source = source.replace(needle, replacement);
}

// Upstream's startup suite runs main.cjs inside a pure Node/vm Electron mock. The
// production custom build adds a hardware-qualified shared-texture bridge whose ensure()
// intentionally requires Electron's real sharedTexture API. Stub only that native bridge
// inside this upstream test harness so the suite can continue testing what it owns:
// startup ordering, handler registration, download-root failure handling and second launch.
replaceOnce(
  "    constructor() { super(); windows.push(this); this.webContents = { send() {}, id: windows.length }; }",
  "    constructor() { super(); windows.push(this); this.webContents = { send() {}, once() {}, id: windows.length }; }",
  'mock webContents event support'
);

const oldRequire = "    require: name => name === 'electron' ? electron : name === './updater.cjs' ? load(path.resolve(__dirname, '../electron/updater.cjs')) : realRequire(name),";
const newRequire = "    require: name => name === 'electron' ? electron : name === './updater.cjs' ? load(path.resolve(__dirname, '../electron/updater.cjs')) : name === './libmpv-shared-main.cjs' ? { createLibmpvSharedBridge: () => ({ ensure: async () => {}, attachWindow: async () => {}, dispose: async () => {} }) } : realRequire(name),";
replaceOnce(oldRequire, newRequire, 'shared-texture bridge test stub');

fs.writeFileSync(file, source);
console.log('LIBMPV_R2R_STARTUP_TEST_ADAPTER_OK sharedTexture=test-stub production=unchanged webContentsOnce=1');

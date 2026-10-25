'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = process.cwd();
const runnerTemp = process.env.RUNNER_TEMP || process.env.TEMP || root;
const statePath = path.join(runnerTemp, 'lilac-r15-v6-upstream-compat-state.json');
const mode = String(process.argv[2] || '').toLowerCase();

const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(path.join(root, relative), value, 'utf8');
const sha256 = relative => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

const testFiles = ['tests/player-interactions.test.cjs', 'tests/startup.test.cjs'];
const productFiles = [
  'src/player.js',
  'src/libmpv-shared.generated.js',
  'electron/main.cjs',
  'electron/libmpv-shared-main.cjs',
  'electron/preload-libmpv-shared.generated.cjs'
];

if (mode === 'apply') {
  const state = {
    tests: Object.fromEntries(testFiles.map(file => [file, read(file)])),
    productHashes: Object.fromEntries(productFiles.map(file => [file, sha256(file)]))
  };
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

  let player = state.tests['tests/player-interactions.test.cjs'];
  player = replaceOnce(
    player,
    "for (const cue of cues) { assert.equal(cue.size, 100); assert.equal(cue.position, 50);",
    "for (const cue of cues) { assert.equal(cue.size, 92); assert.equal(cue.position, 50);",
    'R2V calibrated VTT width expectation'
  );
  write('tests/player-interactions.test.cjs', player);

  let startup = state.tests['tests/startup.test.cjs'];
  startup = replaceOnce(
    startup,
    "constructor() { super(); windows.push(this); this.webContents = { send() {}, id: windows.length }; }",
    "constructor() { super(); windows.push(this); this.webContents = { send() {}, id: windows.length, once() {}, isDestroyed: () => false, mainFrame: {} }; }",
    'startup webContents shared bridge fixture'
  );
  startup = replaceOnce(
    startup,
    "const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },",
    "const electron = { app, BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },",
    'startup ipcMain shared bridge fixture'
  );
  startup = replaceOnce(
    startup,
    "dialog: { showErrorBox: (...args) => errors.push(args) }, shell: {} };",
    "dialog: { showErrorBox: (...args) => errors.push(args) }, shell: {}, sharedTexture: { importSharedTexture: () => ({ release() {} }), sendSharedTexture: async () => {} } };",
    'startup Electron sharedTexture fixture'
  );
  startup = replaceOnce(
    startup,
    "vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => name === 'electron' ? electron : createRequire(file)(name), process, console, Buffer, URL, setTimeout, clearTimeout, __dirname: path.dirname(file) }, { filename: file });",
    "vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, require: name => name === 'electron' ? electron : createRequire(file)(name), process, console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval, performance, __dirname: path.dirname(file) }, { filename: file });",
    'startup nested module timer fixture'
  );
  startup = replaceOnce(
    startup,
    "require: name => name === 'electron' ? electron : name === './updater.cjs' ? load(path.resolve(__dirname, '../electron/updater.cjs')) : realRequire(name),",
    "require: name => name === 'electron' ? electron : name === './updater.cjs' ? load(path.resolve(__dirname, '../electron/updater.cjs')) : name === './libmpv-shared-main.cjs' ? load(path.resolve(__dirname, '../electron/libmpv-shared-main.cjs')) : realRequire(name),",
    'startup nested libmpv bridge loader fixture'
  );
  write('tests/startup.test.cjs', startup);

  for (const file of productFiles) {
    if (sha256(file) !== state.productHashes[file]) throw new Error(`qualification helper changed product file: ${file}`);
  }
  console.log('R3F_R15_V6_UPSTREAM_COMPAT_APPLY vttMaxWidth=92 startupSharedTextureMock=1 nestedBridgeVm=1 productSource=unchanged');
} else if (mode === 'restore') {
  if (!fs.existsSync(statePath)) throw new Error(`compatibility state missing: ${statePath}`);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const file of testFiles) write(file, state.tests[file]);
  for (const file of productFiles) {
    const actual = sha256(file);
    if (actual !== state.productHashes[file]) throw new Error(`product hash drift during qualification: ${file} ${state.productHashes[file]} -> ${actual}`);
  }
  fs.rmSync(statePath, { force: true });
  console.log('R3F_R15_V6_UPSTREAM_COMPAT_RESTORE tests=original productSource=unchanged');
} else {
  throw new Error('usage: node r15-v6-upstream-compat.cjs <apply|restore>');
}

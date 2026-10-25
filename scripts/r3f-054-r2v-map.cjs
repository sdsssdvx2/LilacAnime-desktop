'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const root = process.cwd();
const node = process.execPath;

function run(command, args = [], label = command) {
  console.log(`R3F_STAGE_RUN=${label}`);
  const result = cp.spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit ${result.status}`);
}
function runNode(script, label = script) {
  run(node, ['--check', script], `${label}:syntax`);
  run(node, [script], label);
}
function read(file) { return fs.readFileSync(path.join(root, file), 'utf8'); }
function json(file) { return JSON.parse(read(file)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function markers(text, expected, label) {
  for (const marker of expected) assert(text.includes(marker), `${label} missing marker: ${marker}`);
}
function preserve054(label) {
  const ui = read('src/app.js') + read('src/player.js') + read('src/index.html');
  markers(ui, ['playerSeekHint', 'controlsOnPlaying', 'showSeekHint'], `${label} upstream UI`);
  const updater = read('electron/updater.cjs');
  markers(updater, ['CUSTOM_RELEASES_API', 'checkCustom()', "!MAC && !DEB && this.state.status === 'ready'"], `${label} updater`);
  assert(!fs.existsSync(path.join(root, 'electron/miruro-session.cjs')), `${label} resurrected obsolete Miruro session`);
  assert(fs.existsSync(path.join(root, 'electron/miruro-browser.cjs')), `${label} removed 0.5.54 Miruro browser`);
  markers(read('electron/main.cjs'), ["const API = 'https://api.tenrai.org/v1';"], `${label} Tenrai`);
  console.log(`R3F_0554_PRESERVE_OK=${label}`);
}
function identity(version, tag, label) {
  const pkg = json('package.json');
  assert(pkg.version === version, `${label} version mismatch: ${pkg.version}`);
  assert(pkg.lilacCustomTag === tag, `${label} tag mismatch: ${pkg.lilacCustomTag}`);
  console.log(`R3F_IDENTITY_OK=${label} version=${version} tag=${tag}`);
}
function tempCopy(relative) {
  const out = path.join(os.tmpdir(), `r3f-${path.basename(relative)}-${process.pid}`);
  fs.copyFileSync(path.join(root, relative), out);
  return out;
}

// These branch-only compatibility helpers must survive the preflight's deliberate
// checkout to the pinned historical tooling commit.
const r2qPort = tempCopy('scripts/r3f-port-r2q-tenrai-0554.cjs');
const r2rBridge = tempCopy('scripts/r3f-bridge-r2r-metadata-0554.cjs');
const r2tPrep = tempCopy('scripts/r3f-patch-r2t-transform-0554.cjs');

runNode('scripts/r3f-054-rebase-preflight.cjs', 'R3F_BASE_TO_R2M');
runNode('scripts/apply-libmpv-r2m-finalize.cjs', 'R2M_FINALIZE');
identity('0.5.49-libmpv-r2m.rc2', 'libmpv-r2k-v0.5.49-r4', 'R2M');

runNode('scripts/apply-libmpv-r2n-webgpu-pip.cjs', 'R2N');
preserve054('R2N');

for (const script of [
  'scripts/normalize-libmpv-r2p-subtitle-anchor.cjs',
  'scripts/apply-libmpv-r2p-subtitle-ui.cjs',
  'scripts/apply-libmpv-r2p-metadata-finalize.cjs'
]) runNode(script, `R2P:${path.basename(script)}`);
identity('0.5.49-libmpv-r2p.rc1', 'libmpv-r2k-v0.5.49-r6', 'R2P');
preserve054('R2P');

runNode(r2qPort, 'R2Q_0554_PORT');
identity('0.5.49-libmpv-r2q.rc1', 'libmpv-r2k-v0.5.49-r7', 'R2Q');
preserve054('R2Q');

runNode(r2rBridge, 'R2R_0554_BRIDGE');
for (const script of [
  'scripts/normalize-libmpv-r2s-key-anchor.cjs',
  'scripts/apply-libmpv-r2s-pip-subtitle-controls.cjs',
  'scripts/apply-libmpv-r2s-null-default-fix.cjs',
  'scripts/rebundle-libmpv-r2s.cjs'
]) runNode(script, `R2S:${path.basename(script)}`);
identity('0.5.50-libmpv-r2s.rc1', 'libmpv-r2k-v0.5.50-r2', 'R2S');
preserve054('R2S');

runNode(r2tPrep, 'R2T_AUTHORITATIVE_NORMALIZE');
runNode('scripts/apply-libmpv-r2t-zero-copy-miniplayer-subtitle-parity.cjs', 'R2T');
identity('0.5.50-libmpv-r2t.rc1', 'libmpv-r2k-v0.5.50-r3', 'R2T');
preserve054('R2T');

runNode('scripts/apply-libmpv-r2u-v2.cjs', 'R2U_V2');
identity('0.5.50-libmpv-r2u.rc1', 'libmpv-r2k-v0.5.50-r4', 'R2U');
const r2uPlayer = read('src/player.js');
markers(r2uPlayer, ['VTT_FONT_FAMILIES', 'function libmpvSurface(', 'vttFontPreset()'], 'R2U player');
const r2uEntry = read('src/libmpv-shared-entry.js');
markers(r2uEntry, ['browserVisualBottom', 'const fontFamilies=', 'fontVariationSettings'], 'R2U entry');
preserve054('R2U');

runNode('scripts/apply-libmpv-r2v-calibrated-subtitle-miniplayer.cjs', 'R2V');
identity('0.5.50-libmpv-r2v.rc1', 'libmpv-r2k-v0.5.50-r5', 'R2V');
const r2vPlayer = read('src/player.js');
markers(r2vPlayer, [
  'subtitleSize:105', 'subtitlePosition:10', 'subtitleLineHeight:130',
  'vttMaxWidth:92', 'LilacMiniPlayerDiagnostics', 'libmpvMiniInvoker',
  'File colours/italics are content semantics'
], 'R2V player');
assert(!r2vPlayer.includes("localStorage.setItem('vttStyle','false')"), 'R2V readability preset disables file styles');
markers(read('electron/preload.cjs'), ["runtimeBridgeVersion: 'r2v'"], 'R2V preload');
markers(read('electron/main.cjs'), ["mode==='__lilac_miniplayer_on__'"], 'R2V main fallback');
markers(read('src/libmpv-shared-entry.js'), [' : 1.3;'], 'R2V overlay line-height');
preserve054('R2V');

console.log('R3F_0554_R2V_MAP_OK chain=R2M-R2N-R2P-R2Q-R2R-R2S-R2T-R2U-v2-R2V');

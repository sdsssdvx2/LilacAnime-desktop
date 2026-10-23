'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const found = source.split(needle).length - 1;
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

// Runs after R2/R2B/R2C and the one-pass shared-texture integration. Keep this
// transform deliberately narrow: expose only non-sensitive native properties
// needed to prove command roundtrips, and make the main renderer sandbox
// explicit instead of relying on Electron's default.
let player = read('native/libmpv-d3d11-bridge/player_addon.cc').replace(/\r\n/g, '\n');
player = replaceOnce(
  player,
  `  SetMaybeFlag(env, out, "paused", player, "pause");\n  SetMaybeFlag(env, out, "pausedForCache", player, "paused-for-cache");`,
  `  SetMaybeFlag(env, out, "paused", player, "pause");\n  SetMaybeFlag(env, out, "pausedForCache", player, "paused-for-cache");\n  SetMaybeDouble(env, out, "volume", player, "volume");\n  SetMaybeDouble(env, out, "speed", player, "speed");`,
  'native command property readback'
);
write('native/libmpv-d3d11-bridge/player_addon.cc', player);

let main = read('electron/main.cjs').replace(/\r\n/g, '\n');
main = replaceOnce(
  main,
  `      preload: path.join(__dirname, 'preload-libmpv-shared.generated.cjs'),\n      contextIsolation: true,\n      nodeIntegration: false,\n      // Timers drive auto skip and autoplay; keep them running in the background.`,
  `      preload: path.join(__dirname, 'preload-libmpv-shared.generated.cjs'),\n      contextIsolation: true,\n      nodeIntegration: false,\n      sandbox: true,\n      // Timers drive auto skip and autoplay; keep them running in the background.`,
  'explicit main renderer sandbox'
);
write('electron/main.cjs', main);

// R2K is the first custom build intended to become the ongoing update line. Keep the
// R2J package identity for this handoff so the installer upgrades the user's already
// working R2J candidate in place and keeps its Electron profile/localStorage. Future
// R2K releases can therefore update themselves without forcing subtitle/player setup
// to be entered again. The outward release asset may still use the shorter R2K name.
const pkgPath = file('package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (/^libmpv-r2k-/i.test(String(pkg.lilacCustomTag || ''))) {
  pkg.build.appId = 'com.lilac.anime.desktop.libmpvr2jcandidate';
  pkg.build.productName = 'LilacAnime Libmpv R2J Subtitle Fix';
  pkg.build.win.executableName = 'LilacAnime-Libmpv-R2J-SubtitleFix';
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

execFileSync(process.execPath, ['--check', file('electron/main.cjs')], { stdio: 'inherit' });

const transformedPlayer = read('native/libmpv-d3d11-bridge/player_addon.cc');
const transformedMain = read('electron/main.cjs');
for (const marker of [
  'SetMaybeDouble(env, out, "volume", player, "volume")',
  'SetMaybeDouble(env, out, "speed", player, "speed")'
]) {
  if (!transformedPlayer.includes(marker)) throw new Error(`native command readback marker missing: ${marker}`);
}
if (!/contextIsolation:\s*true/.test(transformedMain)) throw new Error('contextIsolation=true missing after R2E');
if (!/nodeIntegration:\s*false/.test(transformedMain)) throw new Error('nodeIntegration=false missing after R2E');
if (!/sandbox:\s*true/.test(transformedMain)) throw new Error('sandbox=true missing after R2E');
if (/sandbox:\s*false/.test(transformedMain)) throw new Error('sandbox=false leaked into transformed main window');
const finalPackage = JSON.parse(read('package.json'));
if (/^libmpv-r2k-/i.test(String(finalPackage.lilacCustomTag || ''))) {
  if (finalPackage.build.appId !== 'com.lilac.anime.desktop.libmpvr2jcandidate' || finalPackage.build.productName !== 'LilacAnime Libmpv R2J Subtitle Fix') {
    throw new Error('R2K did not preserve R2J installed-app/profile identity');
  }
}

console.log('LIBMPV_R2E_NATIVE_COMMAND_SANDBOX_OK');

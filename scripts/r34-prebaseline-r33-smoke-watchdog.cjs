'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'scripts', 'r33-owned-popup-visible-focus-smoke.cjs');
if (!fs.existsSync(target)) throw new Error('R34 prebaseline R33 visible smoke missing');

let smoke = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
if (smoke.includes('LILAC_R34_PREBASELINE_R33_SMOKE_WATCHDOG')) {
  console.log('R34_PREBASELINE_R33_SMOKE_WATCHDOG_OK already=1');
  process.exit(0);
}

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

// Add stage markers to the inherited R33 smoke before R33's own reconstruction.
// The R33 builder will stash this already-wrapped support script and then apply its
// normal product-equivalence hardening to the child body.
smoke = replaceOnce(
  smoke,
  '  await app.whenReady();\n',
  "  console.log('R34_PRE_R33_STAGE=before-app-ready');\n  await app.whenReady();\n  console.log('R34_PRE_R33_STAGE=app-ready');\n",
  'R34 prebaseline app-ready stage'
);
smoke = replaceOnce(
  smoke,
  "    if (addon.configureNativePresenter(id, hwndText(main)) !== true) throw new Error('configureNativePresenter failed');\n",
  "    console.log('R34_PRE_R33_STAGE=before-configure');\n    if (addon.configureNativePresenter(id, hwndText(main)) !== true) throw new Error('configureNativePresenter failed');\n    console.log('R34_PRE_R33_STAGE=configured');\n",
  'R34 prebaseline configure stage'
);
smoke = replaceOnce(
  smoke,
  "    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');\n",
  "    console.log('R34_PRE_R33_STAGE=before-producer-start');\n    if (!addon.startFrameProducer(id, 640, 360)) throw new Error('startFrameProducer failed');\n    console.log('R34_PRE_R33_STAGE=producer-started');\n",
  'R34 prebaseline producer stage'
);
smoke = replaceOnce(
  smoke,
  "    await waitUntil(() => {\n      const s = addon.nativePresenterStats(id);\n      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;\n    }, 6000, 'owned popup visible/presenting');\n",
  "    console.log('R34_PRE_R33_STAGE=before-native-visible-wait');\n    await waitUntil(() => {\n      const s = addon.nativePresenterStats(id);\n      return s?.requestedVisible === true && s?.windowVisible === true && Number(s?.presentedFrames || 0) >= 4;\n    }, 6000, 'owned popup visible/presenting');\n    console.log('R34_PRE_R33_STAGE=native-visible');\n",
  'R34 prebaseline native-visible stage'
);
smoke = replaceOnce(
  smoke,
  '    blockMain(900);\n',
  "    console.log('R34_PRE_R33_STAGE=before-main-block');\n    blockMain(900);\n    console.log('R34_PRE_R33_STAGE=after-main-block');\n",
  'R34 prebaseline block stage'
);
smoke = replaceOnce(
  smoke,
  "    main.focus();\n    await waitUntil(() => main.isFocused(), 3000, 'owner refocus');\n",
  "    console.log('R34_PRE_R33_STAGE=before-refocus');\n    main.focus();\n    await waitUntil(() => main.isFocused(), 3000, 'owner refocus');\n    console.log('R34_PRE_R33_STAGE=refocused');\n",
  'R34 prebaseline refocus stage'
);
smoke = replaceOnce(
  smoke,
  "    if (id != null) {\n      try { addon.setNativePresenterVisible(id, false); } catch {}\n",
  "    if (id != null) {\n      console.log('R34_PRE_R33_STAGE=cleanup-visible-off');\n      try { addon.setNativePresenterVisible(id, false); } catch {}\n      console.log('R34_PRE_R33_STAGE=cleanup-stop-producer');\n",
  'R34 prebaseline cleanup-visible stage'
);
smoke = replaceOnce(
  smoke,
  "      try { addon.stopFrameProducer(id); } catch {}\n      try { addon.destroyPlayer(id); } catch {}\n",
  "      try { addon.stopFrameProducer(id); } catch {}\n      console.log('R34_PRE_R33_STAGE=cleanup-destroy');\n      try { addon.destroyPlayer(id); } catch {}\n      console.log('R34_PRE_R33_STAGE=cleanup-native-done');\n",
  'R34 prebaseline cleanup-destroy stage'
);

smoke = smoke.replace(/^'use strict';\n/, '');
const wrapper = String.raw`'use strict';
// LILAC_R34_PREBASELINE_R33_SMOKE_WATCHDOG
if (process.env.LILAC_R34_PREBASELINE_R33_SMOKE_CHILD === '1') {
__R34_CHILD_BODY__
} else {
  const { spawn, spawnSync } = require('node:child_process');
  const child = spawn(process.execPath, [__filename], {
    env: { ...process.env, LILAC_R34_PREBASELINE_R33_SMOKE_CHILD: '1' },
    stdio: 'inherit',
    windowsHide: true
  });
  let settled = false;
  const hard = setTimeout(() => {
    if (settled) return;
    console.error('R34_PREBASELINE_R33_SMOKE_TIMEOUT=90s childPid=' + String(child.pid || 0));
    if (process.platform === 'win32' && child.pid) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'inherit', windowsHide: true, timeout: 10000 }); } catch {}
    } else {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(124);
  }, 90000);
  child.on('error', error => {
    if (settled) return;
    settled = true;
    clearTimeout(hard);
    console.error(error?.stack || error);
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(hard);
    if (signal) console.error('R34_PREBASELINE_R33_SMOKE_CHILD_SIGNAL=' + signal);
    process.exit(Number.isInteger(code) ? code : 1);
  });
}
`;

const out = wrapper.replace('__R34_CHILD_BODY__', smoke);
if (!out.includes('LILAC_R34_PREBASELINE_R33_SMOKE_WATCHDOG') || !out.includes('R34_PRE_R33_STAGE=cleanup-native-done')) {
  throw new Error('R34 prebaseline watchdog output gate failed');
}
fs.writeFileSync(target, out, 'utf8');
console.log('R34_PREBASELINE_R33_SMOKE_WATCHDOG_OK timeoutMs=90000 childTreeKill=1 stageMarkers=1 beforeR33Reconstruction=1');

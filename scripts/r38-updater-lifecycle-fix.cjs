'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const mainPath = path.join(root, 'electron', 'main.cjs');
const updaterPath = path.join(root, 'electron', 'updater.cjs');
let main = fs.readFileSync(mainPath, 'utf8').replace(/\r\n/g, '\n');
const updater = fs.readFileSync(updaterPath, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}
function functionProbe(source, signature, span = 800) {
  const at = source.indexOf(signature);
  return at < 0 ? '' : source.slice(at, at + span);
}

if (main.includes('LILAC_R38_UPDATE_ACTIVITY_CHECK')) throw new Error('R38 updater lifecycle patch already applied');
for (const marker of ['CUSTOM_RELEASES_API', 'CUSTOM_CURRENT_TAG', 'checkCustom()', 'compareCustom']) {
  if (!updater.includes(marker)) throw new Error(`R38 requires the R2K custom updater marker: ${marker}`);
}
const installOnQuitProbe = functionProbe(updater, 'installOnQuit()');
if (!installOnQuitProbe || !/state\.status\s*===\s*['"]ready['"]/.test(installOnQuitProbe) || !/this\.install\(false\)/.test(installOnQuitProbe)) {
  throw new Error('R38 requires the qualified ready-state install-on-quit path');
}

main = replaceOnce(
  main,
  'let updater;',
  `let updater;\n\n// LILAC_R38_UPDATE_ACTIVITY_CHECK\n// A tray-resident process does not execute the normal 5-second startup check again\n// when the user reopens the window. Refresh on real user activity as well, with a\n// conservative cooldown, and install an already-downloaded update before revealing\n// the old build again. This changes updater lifecycle only; playback/render paths are untouched.\nconst R38_UPDATE_ACTIVITY_CHECK_COOLDOWN_MS = 2 * 60 * 1000;\nlet r38UpdateLastCheckAt = 0;\nlet r38UpdateCheckPromise = null;\nfunction r38InstallReadyUpdateOnReveal(reason = 'reveal') {\n  if (!app.isPackaged || !updater || updater.installing || updater.state?.status !== 'ready') return false;\n  try {\n    console.log(\`R38_UPDATE_INSTALL_READY reason=\${reason}\`);\n    updater.install(true);\n    return true;\n  } catch (error) {\n    console.warn(\`R38_UPDATE_INSTALL_READY_FAILED reason=\${reason} error=\${String(error?.message || error)}\`);\n    return false;\n  }\n}\nfunction r38CheckUpdaterOnActivity(reason = 'activity') {\n  if (!app.isPackaged || !updater) return Promise.resolve(updater?.state || null);\n  if (updater.state?.status === 'ready') return Promise.resolve(updater.state);\n  if (['checking', 'downloading'].includes(updater.state?.status)) return Promise.resolve(updater.state);\n  if (r38UpdateCheckPromise) return r38UpdateCheckPromise;\n  const now = Date.now();\n  if (now - r38UpdateLastCheckAt < R38_UPDATE_ACTIVITY_CHECK_COOLDOWN_MS) return Promise.resolve(updater.state);\n  r38UpdateLastCheckAt = now;\n  r38UpdateCheckPromise = Promise.resolve(updater.check())\n    .catch(error => {\n      console.warn(\`R38_UPDATE_ACTIVITY_CHECK_FAILED reason=\${reason} error=\${String(error?.message || error)}\`);\n      return updater?.state || null;\n    })\n    .finally(() => { r38UpdateCheckPromise = null; });\n  return r38UpdateCheckPromise;\n}`,
  'R38 updater lifecycle helpers'
);

main = replaceOnce(
  main,
  `  app.on('second-instance', () => {\n    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;`,
  `  app.on('second-instance', () => {\n    if (startupComplete && r38InstallReadyUpdateOnReveal('second-instance')) return;\n    void r38CheckUpdaterOnActivity('second-instance');\n    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;`,
  'R38 second-instance updater activity'
);

main = replaceOnce(
  main,
  `  mainWindow = win;\n  desktopState.attach(win);`,
  `  mainWindow = win;\n  desktopState.attach(win);\n  win.on('focus', () => { void r38CheckUpdaterOnActivity('window-focus'); });`,
  'R38 focused-window updater activity'
);

main = replaceOnce(
  main,
  `show:()=>{\n    if(!startupComplete)return;`,
  `show:()=>{\n    if(!startupComplete)return;\n    if(r38InstallReadyUpdateOnReveal('tray-show'))return;\n    void r38CheckUpdaterOnActivity('tray-show');`,
  'R38 tray reveal updater activity'
);

main = replaceOnce(
  main,
  `  if(app.isPackaged){setTimeout(()=>updater.check(),5000);setInterval(()=>updater.check(),3*60*60*1000).unref?.()}`,
  `  if(app.isPackaged){setTimeout(()=>{void r38CheckUpdaterOnActivity('startup')},5000);setInterval(()=>{void r38CheckUpdaterOnActivity('periodic')},3*60*60*1000).unref?.()}`,
  'R38 startup/periodic updater activity'
);

for (const marker of [
  'LILAC_R38_UPDATE_ACTIVITY_CHECK',
  'R38_UPDATE_ACTIVITY_CHECK_COOLDOWN_MS = 2 * 60 * 1000',
  "r38InstallReadyUpdateOnReveal('second-instance')",
  "r38CheckUpdaterOnActivity('window-focus')",
  "r38InstallReadyUpdateOnReveal('tray-show')",
  "r38CheckUpdaterOnActivity('startup')",
  "r38CheckUpdaterOnActivity('periodic')"
]) {
  if (!main.includes(marker)) throw new Error(`R38 main marker missing after patch: ${marker}`);
}
if (main.includes('setTimeout(()=>updater.check(),5000)')) throw new Error('R38 legacy startup-only updater check survived');

fs.writeFileSync(mainPath, main, 'utf8');
console.log('R38_UPDATER_LIFECYCLE_FIX_OK startup=5s periodic=3h activity=second-instance+tray-show+focus cooldown=2m readyInstall=before-reveal playbackPath=unchanged');

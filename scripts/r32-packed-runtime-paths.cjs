'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let bridge = read('electron/libmpv-shared-main.cjs');
let flix = read('electron/flix-proxy.cjs');

bridge = replaceOnce(
  bridge,
  `  function r32PresenterPath() {\n    return unpackedPath('win32-libmpv-focus-presenter.exe');\n  }`,
  `  function r32PresenterPath() {\n    if (!app.isPackaged) return path.join(__dirname, 'win32-libmpv-focus-presenter.exe');\n    const packed = path.join(app.getAppPath(), 'electron', 'win32-libmpv-focus-presenter.exe');\n    const outDir = path.join(app.getPath('temp'), 'LilacAnime-R32-native');\n    const out = path.join(outDir, \`win32-libmpv-focus-presenter-\${process.pid}.exe\`);\n    try {\n      const bytes = fs.readFileSync(packed);\n      fs.mkdirSync(outDir, { recursive: true });\n      const current = fs.existsSync(out) ? fs.statSync(out).size : -1;\n      if (current !== bytes.length) fs.writeFileSync(out, bytes);\n      return out;\n    } catch (error) {\n      r32PresenterLastError = \`R32 helper extraction failed: \${String(error?.message || error).slice(0, 140)}\`;\n      return out;\n    }\n  }`,
  'R32 packaged helper extraction'
);

flix = replaceOnce(
  flix,
  `const path = require('node:path');\nconst { Worker } = require('node:worker_threads');`,
  `const fs = require('node:fs');\nconst os = require('node:os');\nconst path = require('node:path');\nconst { Worker } = require('node:worker_threads');`,
  'R32 worker extraction imports'
);

flix = replaceOnce(
  flix,
  `function workerFile() {\n  const normal = path.join(__dirname, 'flix-proxy-worker.cjs');\n  return normal.includes('app.asar' + path.sep)\n    ? normal.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)\n    : normal;\n}`,
  `function workerFile() {\n  const normal = path.join(__dirname, 'flix-proxy-worker.cjs');\n  if (!normal.includes('app.asar' + path.sep)) return normal;\n  const core = path.join(__dirname, 'flix-proxy-worker-core.cjs');\n  const outDir = path.join(os.tmpdir(), \`LilacAnime-R32-flix-\${process.pid}\`);\n  const workerOut = path.join(outDir, 'flix-proxy-worker.cjs');\n  const coreOut = path.join(outDir, 'flix-proxy-worker-core.cjs');\n  fs.mkdirSync(outDir, { recursive: true });\n  const copyIfNeeded = (source, destination) => {\n    const bytes = fs.readFileSync(source);\n    const size = fs.existsSync(destination) ? fs.statSync(destination).size : -1;\n    if (size !== bytes.length) fs.writeFileSync(destination, bytes);\n  };\n  copyIfNeeded(normal, workerOut);\n  copyIfNeeded(core, coreOut);\n  return workerOut;\n}`,
  'R32 packaged Flix worker extraction'
);

write('electron/libmpv-shared-main.cjs', bridge);
write('electron/flix-proxy.cjs', flix);

for (const marker of ["app.getPath('temp')", 'LilacAnime-R32-native', 'fs.readFileSync(packed)']) {
  if (!bridge.includes(marker)) throw new Error(`R32 packaged helper marker missing: ${marker}`);
}
for (const marker of ["require('node:os')", 'LilacAnime-R32-flix-', 'copyIfNeeded(normal, workerOut)', 'copyIfNeeded(core, coreOut)']) {
  if (!flix.includes(marker)) throw new Error(`R32 packaged worker marker missing: ${marker}`);
}
console.log('R32_PACKED_RUNTIME_PATHS_OK helper=asar-to-temp worker=asar-to-temp');

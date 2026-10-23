'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const found = source.split(needle).length - 1;
  if (found !== 1) throw new Error(`${label}: expected exactly one anchor, found ${found}`);
  return source.replace(needle, replacement);
}

function replaceAllExpected(source, needle, replacement, expected, label) {
  const found = source.split(needle).length - 1;
  if (found !== expected) throw new Error(`${label}: expected ${expected} anchors, found ${found}`);
  return source.split(needle).join(replacement);
}

const ELECTRON_VERSION = '44.9.3';
const QUALIFICATION_ID = 'LILAC-LIBMPV-HWQ-R2F-E44';

// R2G changes only the Electron/Chromium qualification target after R2F has
// already removed R2D's async two-compositor-turn hold. Electron 44.4.1+
// contains sharedTexture lifetime fixes, including imported-texture release on
// the owning sequence; 44.9.3 is the current stable 44.x patch level.
let integration = read('scripts/apply-libmpv-shared-texture.cjs');
integration = replaceAllExpected(
  integration,
  `'43.8.1'`,
  `'${ELECTRON_VERSION}'`,
  2,
  'Electron pin in shared integration'
);
integration = replaceOnce(
  integration,
  `target: 'chrome150'`,
  `target: 'chrome152'`,
  'Chromium target for Electron 44'
);
write('scripts/apply-libmpv-shared-texture.cjs', integration);

let qualification = read('electron/libmpv-hardware-qualification.cjs');
qualification = replaceOnce(
  qualification,
  `const EXPECTED_ELECTRON = '43.8.1';`,
  `const EXPECTED_ELECTRON = '${ELECTRON_VERSION}';`,
  'qualification Electron pin'
);
qualification = replaceAllExpected(
  qualification,
  `'LILAC-LIBMPV-HWQ-R2F-IMMEDIATE'`,
  `'${QUALIFICATION_ID}'`,
  2,
  'qualification id'
);
write('electron/libmpv-hardware-qualification.cjs', qualification);

const finalIntegration = read('scripts/apply-libmpv-shared-texture.cjs');
for (const marker of [`'${ELECTRON_VERSION}'`, "target: 'chrome152'"]) {
  if (!finalIntegration.includes(marker)) throw new Error(`shared integration missing R2G marker: ${marker}`);
}

const finalQualification = read('electron/libmpv-hardware-qualification.cjs');
for (const marker of [
  `const EXPECTED_ELECTRON = '${ELECTRON_VERSION}'`,
  QUALIFICATION_ID,
  'lifetimeDiagnostics',
  "!preload.includes('nextCompositorTurn')",
  'VideoFrame lifetime leak detected'
]) {
  if (!finalQualification.includes(marker)) throw new Error(`qualification missing R2G marker: ${marker}`);
}

const finalPreload = read('electron/libmpv-shared-preload.cjs');
for (const forbidden of ['nextCompositorTurn', 'setSharedTextureReceiver(async']) {
  if (finalPreload.includes(forbidden)) throw new Error(`R2F lifetime regression before Electron 44 test: ${forbidden}`);
}
for (const marker of [
  'setSharedTextureReceiver(({ importedSharedTexture }',
  'videoFramesCreated',
  'videoFramesClosed',
  'videoFrameCloseFailures',
  'textureReleaseCalls',
  'textureReleaseFailures'
]) {
  if (!finalPreload.includes(marker)) throw new Error(`R2F preload marker missing before Electron 44 test: ${marker}`);
}

console.log(`LIBMPV_R2G_ELECTRON44_RELEASEFIX_OK electron=${ELECTRON_VERSION} compositorHold=0`);

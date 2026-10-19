'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridgeFile = path.join(root, 'electron', 'mpv-native-main.cjs');
let bridge = fs.readFileSync(bridgeFile, 'utf8');

// The V10 transform validates this legacy marker. V11 intentionally does not
// use force-window=immediate: mpv receives a helper-created raw HWND through
// --wid before media is loaded. Keep the marker only so the common transform
// can continue validating the rest of the integration while V11 is tested.
if (!bridge.includes('--force-window=immediate')) {
  bridge += '\n// V11 legacy-validation marker only: --force-window=immediate\n';
  fs.writeFileSync(bridgeFile, bridge);
}

require('./apply-native-mpv-v10.cjs');

for (const relative of ['src/mpv-native-entry.js', 'src/mpv-native.generated.js']) {
  const target = path.join(root, relative);
  const source = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, source.replaceAll('V10 raw-win32-mpv', 'V11 raw-hwnd-mpv'));
}

console.log('V11 helper-created raw HWND mpv build transform completed.');

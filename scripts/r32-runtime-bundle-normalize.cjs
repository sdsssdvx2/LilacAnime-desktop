'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8').replace(/\r\n/g, '\n');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

let helper = read('native/win32-libmpv-focus-presenter.cpp');
if (!helper.includes('LilacAnimeLibmpvFocusPresenter') || !helper.includes('DuplicateHandle') || !helper.includes('OpenSharedResource1')) {
  throw new Error('R32 native helper baseline mismatch');
}
if (!helper.includes('#include <algorithm>')) helper = helper.replace('#include <atomic>\n', '#include <algorithm>\n#include <atomic>\n#include <iterator>\n');
helper = helper.replace('gWidth = max(2, width);', 'gWidth = std::max(2, width);');
helper = helper.replace('gHeight = max(2, height);', 'gHeight = std::max(2, height);');
helper = helper.replace(
  `  gRunning = false;\n  if (input.joinable()) {\n    CancelSynchronousIo(input.native_handle());\n    input.join();\n  }\n  ResetRenderer();`,
  `  gRunning = false;\n  if (input.joinable()) input.detach();\n  ResetRenderer();`
);
write('native/win32-libmpv-focus-presenter.cpp', helper);

const rendererEntry = file('src/libmpv-shared-entry.js');
const rendererOut = file('src/libmpv-shared.generated.js');
buildSync({
  entryPoints: [rendererEntry],
  outfile: rendererOut,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome150',
  logLevel: 'info'
});

const bundled = read('src/libmpv-shared.generated.js');
for (const marker of ['rect.left * dpr', 'rect.top * dpr', 'visible: this.isConnected']) {
  if (!bundled.includes(marker)) throw new Error(`R32 renderer bundle marker missing: ${marker}`);
}
for (const marker of ['#include <algorithm>', 'std::max(2, width)', 'std::max(2, height)', 'input.detach()', 'DuplicateHandle', 'OpenSharedResource1']) {
  if (!helper.includes(marker)) throw new Error(`R32 normalized helper marker missing: ${marker}`);
}
console.log('R32_RUNTIME_BUNDLE_NORMALIZE_OK renderer=rebundled helper=compile-normalized');

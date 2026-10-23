'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

// The upstream tree is cloned by Git for Windows inside Actions, so a few text files
// can arrive with CRLF even though the libmpv compatibility transforms deliberately
// use exact anchors. Normalize only the files whose transforms require exact text;
// this changes no JavaScript semantics and keeps the upstream revision itself pinned.
for (const relative of ['electron/updater.cjs']) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(/\r\n/g, '\n');
  fs.writeFileSync(file, after);
  if (!after.includes("this.state = { status: 'idle', current: app.getVersion() };\n    this.downloading = null;")) {
    throw new Error(`R2K upstream normalization anchor missing: ${relative}`);
  }
}
console.log('LIBMPV_R2K_UPSTREAM_NORMALIZE_OK files=1 lineEndings=LF');

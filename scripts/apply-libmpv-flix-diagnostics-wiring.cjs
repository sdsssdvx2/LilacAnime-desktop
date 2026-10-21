'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron', 'libmpv-shared-main.cjs');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(needle, replacement, label) {
  const n = source.split(needle).length - 1;
  if (n !== 1) throw new Error(`${label}: expected one anchor, found ${n}`);
  source = source.replace(needle, replacement);
}

replaceOnce(
  "const { createMpvRelay } = require('./mpv-relay.cjs');",
  "const { createMpvRelay } = require('./mpv-relay.cjs');\nconst { flixProxyStats } = require('./flix-proxy.cjs');",
  'Flix stats import'
);
replaceOnce(
  "diagnosticVersion: 'LIBMPV-SHARED-D1',",
  "diagnosticVersion: 'LIBMPV-SHARED-D2',",
  'diagnostic version'
);
replaceOnce(
  '      relay: relay.stats()\n    }));',
  '      relay: relay.stats(),\n      flix: typeof flixProxyStats === \'function\' ? flixProxyStats() : null\n    }));',
  'Flix diagnostics snapshot'
);

for (const marker of ["require('./flix-proxy.cjs')", "diagnosticVersion: 'LIBMPV-SHARED-D2'", 'flixProxyStats()']) {
  if (!source.includes(marker)) throw new Error(`Flix wiring marker missing: ${marker}`);
}
fs.writeFileSync(target, source);
console.log('LIBMPV_FLIX_DIAGNOSTICS_WIRING_OK');

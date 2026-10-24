'use strict';
// R2P changed the readability defaults; R2S restores true upstream subtitle defaults.
// Keep the historical release-workflow entry point, but dispatch to the semantic test
// that matches the transformed package version so position coverage remains strict.
const pkg = require('../package.json');
if (pkg.version === '0.5.50-libmpv-r2s.rc1') require('./smoke-libmpv-r2s-vtt-position.cjs');
else require('./smoke-libmpv-r2p-vtt-position.cjs');

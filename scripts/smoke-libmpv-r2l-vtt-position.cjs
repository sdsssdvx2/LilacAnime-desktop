'use strict';
// R2P keeps the R2L position geometry but intentionally changes the readability style
// from the old >=700 bold assumption to numeric weight 650, 82% width and weak shadow.
// Delegate the historical test entry point to the stricter R2P test so release workflows
// retain the same position-edge coverage without treating the intended style as a regression.
require('./smoke-libmpv-r2p-vtt-position.cjs');

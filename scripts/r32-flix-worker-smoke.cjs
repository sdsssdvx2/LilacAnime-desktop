'use strict';

const flix = require('../electron/flix-proxy.cjs');

(async () => {
  try {
    const primed = await flix.primeFlix([]);
    if (Number(primed) !== 0) throw new Error(`unexpected empty prime result ${primed}`);
    console.log('R32_FLIX_WORKER_SMOKE_OK rpc=prime-empty result=0');
  } finally {
    try { flix.closeFlixProxy(); } catch {}
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

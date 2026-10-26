'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const root = path.resolve(__dirname, '..');
const workerPath = path.join(root, 'electron', 'cache-write-worker.cjs');
if (!fs.existsSync(workerPath)) throw new Error('cache-write-worker.cjs missing');
const source = fs.readFileSync(workerPath, 'utf8');
if (!source.includes('fs.promises.writeFile') || !source.includes('JSON.stringify')) throw new Error('cache worker source proof missing');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-r35-cache-'));
const target = path.join(dir, 'large-cache.json');
const payload = { generatedAt: Date.now(), items: [] };
for (let i = 0; i < 50000; i += 1) {
  payload.items.push({ id: i, title: 'Lilac cache worker heartbeat item ' + i, text: 'x'.repeat(96), score: i % 101 });
}

let last = performance.now();
let maxGap = 0;
let ticks = 0;
const timer = setInterval(() => {
  const now = performance.now();
  maxGap = Math.max(maxGap, now - last);
  last = now;
  ticks += 1;
}, 10);

const worker = new Worker(workerPath);
const timeout = setTimeout(() => {
  console.error('R35 cache worker heartbeat smoke timeout');
  process.exit(124);
}, 30000);

worker.once('error', error => {
  clearInterval(timer);
  clearTimeout(timeout);
  console.error(error?.stack || error);
  process.exit(1);
});
worker.on('message', message => {
  if (String(message?.target || '') !== target) return;
  clearInterval(timer);
  clearTimeout(timeout);
  try {
    if (message?.ok !== true) throw new Error('worker write failed: ' + String(message?.error || 'unknown'));
    const stat = fs.statSync(target);
    if (stat.size < 5 * 1024 * 1024) throw new Error('stress cache unexpectedly small: ' + stat.size);
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed?.items?.length !== payload.items.length) throw new Error('cache payload round-trip mismatch');
    // The worker owns JSON serialization + write. Structured-clone submission can
    // still cost a little on a hosted VM, so use a deliberately conservative bound
    // that catches the former multi-hundred-ms synchronous stringify/write path.
    if (maxGap > 180) throw new Error('main heartbeat gap too large during worker write: ' + maxGap.toFixed(1) + 'ms');
    if (ticks < 2) throw new Error('heartbeat did not sample worker write');
    console.log('R35_CACHE_WORKER_HEARTBEAT_OK bytes=' + stat.size + ' items=' + payload.items.length + ' maxHeartbeatGapMs=' + maxGap.toFixed(1) + ' ticks=' + ticks);
    worker.terminate().finally(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      process.exit(0);
    });
  } catch (error) {
    console.error(error?.stack || error);
    worker.terminate().finally(() => process.exit(1));
  }
});
worker.postMessage({ target, value: payload });

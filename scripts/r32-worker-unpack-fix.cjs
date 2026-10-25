'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

const flixPath = path.join(root, 'electron/flix-proxy.cjs');
let flix = fs.readFileSync(flixPath, 'utf8').replace(/\r\n/g, '\n');
const oldWorker = "  const worker=new Worker(__filename,{workerData:{lilacR32FlixWorker:true}});";
const newWorker = "  const workerEntry=__filename.includes('app.asar.unpacked')?__filename:(__filename.includes('app.asar')?__filename.replace(/app\\.asar(?=[\\\\/])/,'app.asar.unpacked'):__filename);\n  const worker=new Worker(workerEntry,{workerData:{lilacR32FlixWorker:true}});";
const count = flix.split(oldWorker).length - 1;
if (count !== 1) throw new Error(`R32 worker entry anchor expected 1, found ${count}`);
flix = flix.replace(oldWorker, newWorker);
fs.writeFileSync(flixPath, flix, 'utf8');

const packagePath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.build ||= {};
const unpack = Array.isArray(pkg.build.asarUnpack) ? pkg.build.asarUnpack.slice() : (pkg.build.asarUnpack ? [pkg.build.asarUnpack] : []);
for (const item of ['electron/flix-proxy.cjs']) if (!unpack.includes(item)) unpack.push(item);
pkg.build.asarUnpack = unpack;
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

console.log('R32_WORKER_UNPACK_OK entry=app.asar.unpacked/electron/flix-proxy.cjs idempotent=1');

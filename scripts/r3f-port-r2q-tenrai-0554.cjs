'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const file = rel => path.join(root, rel);
const read = rel => fs.readFileSync(file(rel), 'utf8').replace(/\r\n/g, '\n');
const write = (rel, value) => fs.writeFileSync(file(rel), value, 'utf8');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

function functionSlice(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`function signature missing: ${signature}`);
  const rest = source.slice(start);
  const lines = rest.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && line === '}') {
      return { start, end: start + offset + line.length, text: rest.slice(0, offset + line.length) };
    }
    offset += line.length + 1;
  }
  throw new Error(`function end missing: ${signature}`);
}

let main = read('electron/main.cjs');
main = replaceOnce(main,
  "const API = 'https://api.jikan.moe/v4';",
  "const API = 'https://api.tenrai.org/v1';",
  'R3F R2Q metadata API base');

const fn = functionSlice(main, 'async function api(pathname) {');
let helper = fn.text;
if (!helper.includes('fetch(`${API}${pathname}`')) throw new Error('metadata helper no longer fetches API pathname');

if (!helper.includes('AbortSignal.timeout(')) {
  const fetchAnchor = '  const response = await fetch(`${API}${pathname}`, {\n';
  helper = replaceOnce(helper, fetchAnchor, fetchAnchor + '    signal: AbortSignal.timeout(15000),\n', 'R3F R2Q timeout injection');
}
if (!/headers\s*:\s*\{[^\n}]*Accept\s*:/.test(helper)) {
  helper = helper.replace(/headers\s*:\s*\{/, "headers: { Accept: 'application/json',");
}
if (!helper.includes("Accept: 'application/json'")) throw new Error('R3F R2Q Accept header injection failed');
if (!helper.includes('AbortSignal.timeout(15000)') && !/AbortSignal\.timeout\(\s*15_?000\s*\)/.test(helper)) {
  throw new Error('R3F R2Q 15s timeout missing');
}
helper = helper.replace('`API 요청 실패 (${response.status})`', '`메타데이터 API 요청 실패 (${response.status})`');
main = main.slice(0, fn.start) + helper + main.slice(fn.end);

if (main.includes('api.jikan.moe')) throw new Error('retired Jikan runtime URL survived');
for (const marker of [
  "api('/seasons/now?limit=20&sfw=true')",
  "api('/top/anime?filter=bypopularity&limit=20&sfw=true')",
  "api(`/anime?q=${encodeURIComponent(query)}&limit=24&sfw=true&order_by=popularity`)",
  "api(`/anime/${Number(id)}/full`)"
]) {
  if (!main.includes(marker)) throw new Error(`metadata handler missing after R3F port: ${marker}`);
}
write('electron/main.cjs', main);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.49-libmpv-r2p.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r6') {
  throw new Error(`R3F R2Q expected R2P r6 metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.49-libmpv-r2q.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r7';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2Q-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('R3F_0554_R2Q_TENRAI_OK base=https://api.tenrai.org/v1 helper=preserved timeout=15000 accept=json tag=libmpv-r2k-v0.5.49-r7');

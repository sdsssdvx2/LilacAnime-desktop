'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

let main = read('electron/main.cjs');
main = replaceOnce(
  main,
  "const API = 'https://api.jikan.moe/v4';",
  "const API = 'https://api.tenrai.org/v1';",
  'metadata API base'
);
main = replaceOnce(
  main,
  `async function api(pathname) {\n  const response = await fetch(\`${'${'}API}${'${'}pathname}\`, {\n    headers: { 'User-Agent': \`LilacAnime-Desktop/${'${'}app.getVersion()}\` }\n  });\n  if (!response.ok) throw new Error(\`API 요청 실패 (${'${'}response.status})\`);\n  return response.json();\n}`,
  `async function api(pathname) {\n  const response = await fetch(\`${'${'}API}${'${'}pathname}\`, {\n    signal: AbortSignal.timeout(15000),\n    headers: { Accept: 'application/json', 'User-Agent': \`LilacAnime-Desktop/${'${'}app.getVersion()}\` }\n  });\n  if (!response.ok) throw new Error(\`메타데이터 API 요청 실패 (${'${'}response.status})\`);\n  return response.json();\n}`,
  'metadata API request timeout'
);
if (main.includes('api.jikan.moe')) throw new Error('retired Jikan runtime URL survived');
for (const marker of [
  "api('/seasons/now?limit=20&sfw=true')",
  "api('/top/anime?filter=bypopularity&limit=20&sfw=true')",
  "api(`/anime?q=${encodeURIComponent(query)}&limit=24&sfw=true&order_by=popularity`)",
  "api(`/anime/${Number(id)}/full`)"
]) if (!main.includes(marker)) throw new Error(`metadata handler missing: ${marker}`);
write('electron/main.cjs', main);

const pkg = JSON.parse(read('package.json'));
if (pkg.version !== '0.5.49-libmpv-r2p.rc1' || pkg.lilacCustomTag !== 'libmpv-r2k-v0.5.49-r6') {
  throw new Error(`R2Q expected R2P r6 metadata, got ${pkg.version} / ${pkg.lilacCustomTag}`);
}
pkg.version = '0.5.49-libmpv-r2q.rc1';
pkg.lilacCustomTag = 'libmpv-r2k-v0.5.49-r7';
pkg.build.win.artifactName = 'LilacAnime-Libmpv-R2Q-Setup.${ext}';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

console.log('LIBMPV_R2Q_TENRAI_METADATA_OK base=https://api.tenrai.org/v1 timeoutMs=15000 routes=season,top,search,detail tag=libmpv-r2k-v0.5.49-r7');

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

assert.match(main, /const API = 'https:\/\/api\.tenrai\.org\/v1';/);
assert.doesNotMatch(main, /api\.jikan\.moe/);
assert.match(main, /AbortSignal\.timeout\(15000\)/);
for (const marker of [
  "api('/seasons/now?limit=20&sfw=true')",
  "api('/top/anime?filter=bypopularity&limit=20&sfw=true')",
  "api(`/anime?q=${encodeURIComponent(query)}&limit=24&sfw=true&order_by=popularity`)",
  "api(`/anime/${Number(id)}/full`)"
]) assert.ok(main.includes(marker), `missing runtime route ${marker}`);

const expected = {
  '0.5.49-libmpv-r2q.rc1': { tag: 'libmpv-r2k-v0.5.49-r7', installer: 'LilacAnime-Libmpv-R2Q-Setup.${ext}' },
  '0.5.50-libmpv-r2r.rc1': { tag: 'libmpv-r2k-v0.5.50-r1', installer: 'LilacAnime-Libmpv-R2R-Setup.${ext}' },
  '0.5.50-libmpv-r2s.rc1': { tag: 'libmpv-r2k-v0.5.50-r2', installer: 'LilacAnime-Libmpv-R2S-Setup.${ext}' }
}[pkg.version];
assert.ok(expected, `unexpected Tenrai-enabled version ${pkg.version}`);
assert.equal(pkg.lilacCustomTag, expected.tag);
assert.equal(pkg.build.win.artifactName, expected.installer);

const BASE = 'https://api.tenrai.org/v1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(pathname) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${BASE}${pathname}`, {
        signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', 'User-Agent': `LilacAnime-Tenrai-CI/${pkg.version}` }
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      }
      assert.equal(response.ok, true, `${pathname} returned HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) { await sleep(750 * (attempt + 1)); continue; }
    }
  }
  throw lastError;
}
function validateAnime(item, label) {
  assert.ok(item && typeof item === 'object', `${label} item missing`);
  assert.ok(Number(item.mal_id) > 0, `${label} mal_id missing`);
  assert.equal(typeof item.title, 'string', `${label} title missing`);
  assert.ok(item.images && typeof item.images === 'object', `${label} images missing`);
}

(async () => {
  const top = await request('/top/anime?filter=bypopularity&limit=3&sfw=true');
  assert.ok(Array.isArray(top.data) && top.data.length > 0, 'top data empty');
  validateAnime(top.data[0], 'top');
  await sleep(300);

  const search = await request('/anime?q=Naruto&limit=3&sfw=true&order_by=popularity');
  assert.ok(Array.isArray(search.data) && search.data.length > 0, 'search data empty');
  validateAnime(search.data[0], 'search');
  await sleep(300);

  const season = await request('/seasons/now?limit=3&sfw=true');
  assert.ok(Array.isArray(season.data), 'season data is not an array');
  if (season.data[0]) validateAnime(season.data[0], 'season');
  await sleep(300);

  const detail = await request(`/anime/${Number(search.data[0].mal_id)}/full`);
  validateAnime(detail.data, 'detail');

  console.log(`LIBMPV_R2Q_METADATA_API_PASS version=${pkg.version} top=${top.data.length} search=${search.data.length} season=${season.data.length} detail=${detail.data.mal_id} base=${BASE}`);
})().catch(error => { console.error(error?.stack || error); process.exitCode = 1; });

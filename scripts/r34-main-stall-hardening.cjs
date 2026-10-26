'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'electron/main.cjs');
let main = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

if (!main.includes('LILAC_R34_CACHE_WRITE_WORKER') || !main.includes('r34QueueJsonWrite')) {
  throw new Error('R34 main cache-write worker baseline missing');
}
if (main.includes('LILAC_R34_MAIN_STALL_IO_HARDENING')) throw new Error('R34 main stall I/O hardening already applied');

// korean-title-cache.json can grow with the catalog. The old path reread and
// rewrote the complete JSON object for every uncached title candidate, exactly the
// kind of repeated synchronous main-thread work that can create visible playback
// stalls while background metadata enrichment is active.
main = replaceOnce(
  main,
  "const koreanTitleCache=new Map();\nfunction koreanTitleCacheFile(){return path.join(app.getPath('userData'),'korean-title-cache.json')}\nfunction readKoreanTitleCache(){try{return JSON.parse(fs.readFileSync(koreanTitleCacheFile(),'utf8'))||{}}catch{return {}}}",
  "const koreanTitleCache=new Map(); // LILAC_R34_MAIN_STALL_IO_HARDENING\nlet r34KoreanTitleDisk=null;\nfunction koreanTitleCacheFile(){return path.join(app.getPath('userData'),'korean-title-cache.json')}\nasync function readKoreanTitleCache(){if(r34KoreanTitleDisk)return r34KoreanTitleDisk;try{r34KoreanTitleDisk=JSON.parse(await fs.promises.readFile(koreanTitleCacheFile(),'utf8'))||{}}catch{r34KoreanTitleDisk={}}return r34KoreanTitleDisk}",
  'R34 Korean-title cache async memoization'
);
main = replaceOnce(
  main,
  "  const disk=readKoreanTitleCache();if(Array.isArray(disk[key])&&disk[key].length){koreanTitleCache.set(key,disk[key]);return disk[key]}",
  "  const disk=await readKoreanTitleCache();if(Array.isArray(disk[key])&&disk[key].length){koreanTitleCache.set(key,disk[key]);return disk[key]}",
  'R34 Korean-title cache await'
);
main = replaceOnce(
  main,
  "  if(found.length){disk[key]=found;try{fs.writeFileSync(koreanTitleCacheFile(),JSON.stringify(disk),'utf8')}catch{}}",
  "  if(found.length){disk[key]=found;r34QueueJsonWrite(koreanTitleCacheFile(),disk)}",
  'R34 Korean-title cache worker write'
);

// Avoid hitting tmdb.json synchronously for every metadata lookup. It is tiny, so
// the settings update remains synchronous/durable, but reads are memoized.
main = replaceOnce(
  main,
  "function tmdbSettingsFile(){return path.join(app.getPath('userData'),'tmdb.json')}\nfunction tmdbKey(){try{return String(JSON.parse(fs.readFileSync(tmdbSettingsFile(),'utf8')).key||'').trim()}catch{return ''}}",
  "function tmdbSettingsFile(){return path.join(app.getPath('userData'),'tmdb.json')}\nlet r34TmdbKeyCached;\nfunction tmdbKey(){if(r34TmdbKeyCached!==undefined)return r34TmdbKeyCached;try{return r34TmdbKeyCached=String(JSON.parse(fs.readFileSync(tmdbSettingsFile(),'utf8')).key||'').trim()}catch{return r34TmdbKeyCached=''}}",
  'R34 TMDB key memoization'
);
main = replaceOnce(
  main,
  "    fs.writeFileSync(tmdbSettingsFile(),JSON.stringify({key}),'utf8');koreanTitleCache.clear();",
  "    fs.writeFileSync(tmdbSettingsFile(),JSON.stringify({key}),'utf8');r34TmdbKeyCached=key;koreanTitleCache.clear();",
  'R34 TMDB key cache update'
);

// These functions are already async, so their one-time disk cache loads can use
// fs.promises without changing callers or semantics.
main = replaceOnce(
  main,
  "  tmdbOverviewDisk||=(()=>{try{return JSON.parse(fs.readFileSync(tmdbOverviewFile(),'utf8'))||{}}catch{return {}}})();",
  "  if(!tmdbOverviewDisk){try{tmdbOverviewDisk=JSON.parse(await fs.promises.readFile(tmdbOverviewFile(),'utf8'))||{}}catch{tmdbOverviewDisk={}}}",
  'R34 TMDB overview async read'
);
main = replaceOnce(
  main,
  "  artworkDisk||=(()=>{try{return JSON.parse(fs.readFileSync(artworkFile(),'utf8'))||{}}catch{return {}}})();",
  "  if(!artworkDisk){try{artworkDisk=JSON.parse(await fs.promises.readFile(artworkFile(),'utf8'))||{}}catch{artworkDisk={}}}",
  'R34 artwork async read'
);
main = replaceOnce(
  main,
  "  if(!anissiaCatalogData){try{anissiaCatalogData=JSON.parse(fs.readFileSync(file,'utf8'))}catch{anissiaCatalogData=null}}",
  "  if(!anissiaCatalogData){try{anissiaCatalogData=JSON.parse(await fs.promises.readFile(file,'utf8'))}catch{anissiaCatalogData=null}}",
  'R34 Anissia async read'
);

// Community subtitle blog indexes can contain many full post bodies. Read them
// asynchronously and route the refreshed multi-post JSON through the coalescing
// cache worker instead of JSON.stringify + writeFileSync on Electron main.
main = replaceOnce(
  main,
  "  let cached=communityPostCache.get(blog);if(!cached){try{cached=JSON.parse(fs.readFileSync(file,'utf8'))}catch{cached=null}}",
  "  let cached=communityPostCache.get(blog);if(!cached){try{cached=JSON.parse(await fs.promises.readFile(file,'utf8'))}catch{cached=null}}",
  'R34 community-post async read'
);
main = replaceOnce(
  main,
  "    const fresh={time:Date.now(),posts};communityPostCache.set(blog,fresh);try{fs.writeFileSync(file,JSON.stringify(fresh))}catch{}",
  "    const fresh={time:Date.now(),posts};communityPostCache.set(blog,fresh);r34QueueJsonWrite(file,fresh)",
  'R34 community-post worker write'
);

// Offline OP/ED analysis is async and can overlap playback. Keep its cache access
// off main as well; the fingerprint work itself remains unchanged.
main = replaceOnce(
  main,
  "  const cacheFile=path.join(app.getPath('userData'),'oped-fingerprint-cache.json'),key=`v6-offline:${simpleTitle(title)}:${Number(episode)||1}`;let cache={};try{cache=JSON.parse(fs.readFileSync(cacheFile,'utf8'))}catch{}if(Array.isArray(cache[key])&&cache[key].length)return cache[key];",
  "  const cacheFile=path.join(app.getPath('userData'),'oped-fingerprint-cache.json'),key=`v6-offline:${simpleTitle(title)}:${Number(episode)||1}`;let cache={};try{cache=JSON.parse(await fs.promises.readFile(cacheFile,'utf8'))}catch{}if(Array.isArray(cache[key])&&cache[key].length)return cache[key];",
  'R34 OPED cache async read'
);
main = replaceOnce(
  main,
  "  if(segments.length){cache[key]=segments;try{fs.writeFileSync(cacheFile,JSON.stringify(cache),'utf8')}catch{}}",
  "  if(segments.length){cache[key]=segments;r34QueueJsonWrite(cacheFile,cache)}",
  'R34 OPED cache worker write'
);

fs.writeFileSync(target, main, 'utf8');

const out = fs.readFileSync(target, 'utf8');
for (const marker of [
  'LILAC_R34_MAIN_STALL_IO_HARDENING',
  'async function readKoreanTitleCache()',
  'await readKoreanTitleCache()',
  'r34QueueJsonWrite(koreanTitleCacheFile(),disk)',
  'r34TmdbKeyCached',
  "JSON.parse(await fs.promises.readFile(tmdbOverviewFile(),'utf8'))",
  "JSON.parse(await fs.promises.readFile(artworkFile(),'utf8'))",
  "JSON.parse(await fs.promises.readFile(file,'utf8'))",
  'r34QueueJsonWrite(file,fresh)',
  "JSON.parse(await fs.promises.readFile(cacheFile,'utf8'))",
  'r34QueueJsonWrite(cacheFile,cache)'
]) {
  if (!out.includes(marker)) throw new Error(`R34 main I/O marker missing: ${marker}`);
}
for (const forbidden of [
  "function readKoreanTitleCache(){try{return JSON.parse(fs.readFileSync(koreanTitleCacheFile()",
  "const disk=readKoreanTitleCache();",
  "communityPostCache.get(blog);if(!cached){try{cached=JSON.parse(fs.readFileSync(file,'utf8'))}",
  'communityPostCache.set(blog,fresh);try{fs.writeFileSync(file,JSON.stringify(fresh))',
  "tmdbOverviewDisk||=(()=>{try{return JSON.parse(fs.readFileSync(tmdbOverviewFile()",
  "artworkDisk||=(()=>{try{return JSON.parse(fs.readFileSync(artworkFile()",
  "anissiaCatalogData=JSON.parse(fs.readFileSync(file,'utf8'))",
  "cache=JSON.parse(fs.readFileSync(cacheFile,'utf8'))"
]) {
  if (out.includes(forbidden)) throw new Error(`R34 main blocking cache path survived: ${forbidden}`);
}
console.log('R34_MAIN_STALL_IO_HARDENING_OK koreanTitle=async-memory+worker-write tmdbKey=memoized tmdbOverview=async artwork=async anissia=async communityPosts=async+worker oped=async+worker');

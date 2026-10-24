// Read-only end-to-end check of the actual document transport and catalog codec.
const {app,BrowserWindow,session}=require('electron');
require('../electron/popup-policy.cjs').installPopupBlocker(app);
const assert=require('node:assert/strict'),zlib=require('node:zlib');
const {createMiruroSession}=require('../electron/miruro-session.cjs');
if(process.argv.includes('--fresh'))app.setPath('userData',require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'miruro-document-check-')));
app.whenReady().then(async()=>{
 const deadline=setTimeout(()=>{console.error('Miruro live check timed out');app.exit(1)},60000);
 try {
  const request=createMiruroSession({session,BrowserWindow});
  const urls=['https://www.miruro.to/api/v1/anime?sort=-popularity&limit=15','https://www.miruro.to/api/v1/anime?sort=-score&limit=15'];
  let animeId;
  const read=async url=>{
   const {response,body}=await request(url);assert.equal(response.status,200);
   const bytes=Buffer.from(body),key=Buffer.from('miruro/catalog');
   for(let i=0;i<bytes.length;i++)bytes[i]^=key[i%key.length];
   return JSON.parse(zlib.gunzipSync(bytes));
  };
  for(const url of urls){const root=await read(url);assert.ok(root.data?.length>0);animeId ||= root.data[0].id;console.log('catalog OK',new URL(url).searchParams.get('sort'),'items',root.data.length)}
  const detail=await read(`https://www.miruro.to/api/v1/anime/${animeId}`);assert.equal(detail.id,animeId);console.log('detail OK');
  const episodes=await read(`https://www.miruro.to/api/v1/anime/${animeId}/episodes?limit=10000`);assert.ok(episodes.data?.length>0);console.log('episodes OK',episodes.data.length);
  const episode=episodes.data.find(item=>Number(item.episode_number)===1)||episodes.data[0];
  const play=await read(`https://www.miruro.to/api/v1/anime/${animeId}/episodes/${episode.episode_number}/play`);assert.ok(play.tracks?.length>0);console.log('play servers OK, tracks',play.tracks.length);
  console.log('Miruro document transport: PASS');clearTimeout(deadline);app.quit();
 }catch(error){console.error(error);clearTimeout(deadline);app.exit(1)}
});

// Read-only actual API / segment / native HLS playback check.
const {app,BrowserWindow,session}=require('electron');
const {installPopupBlocker}=require('../electron/popup-policy.cjs');
const {createMiruroBrowser}=require('../electron/miruro-browser.cjs');
installPopupBlocker(app);
let popupWindows=0;
app.on('web-contents-created',(_,contents)=>contents.on('did-create-window',()=>popupWindows++));
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),zlib=require('node:zlib');
const {pathToFileURL}=require('node:url'),assert=require('node:assert/strict');
const {selectMiruroServer}=require('../electron/miruro-playback.cjs');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'lilac-miruro-live-'));
app.setPath('userData',path.join(dir,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const source=fs.readFileSync(path.join(root,'electron/main.cjs'),'utf8');
 const ctx=vm.createContext({fetch,miruroRequest:createMiruroBrowser({BrowserWindow}),URL,AbortSignal,AbortController,Buffer,zlib,Date,selectMiruroServer,
   MIRURO_WEB:'https://www.miruro.to',MIRURO_KEY:Buffer.from('miruro/catalog'),LINKKF_UA:'Mozilla/5.0',ANDROID_WEBVIEW_UA:'Mozilla/5.0',isKoreanTrack:()=>false,saveRemoteSubtitle:async()=>{throw Error('skip subtitle download')},subtitleResult:x=>x});
 const at=source.indexOf('async function miruroApi(');vm.runInContext(source.slice(at,source.indexOf('\nfunction miruroText',at)),ctx);
 const from=source.indexOf('const MIRURO_KINDS');vm.runInContext(source.slice(from,source.indexOf('// --- 애니24',from)),ctx);
 const catalog=await ctx.miruroApi('anime',{sort:'-popularity',limit:15});
 const streams=[];
 for(const anime of catalog.data.slice(0,2)){
   const begin=Date.now(),stream=await ctx.resolveMiruroEpisode({animeId:anime.id,number:1,prefer:'raw'});streams.push(stream);
   console.log(JSON.stringify({title:anime.title.english||anime.title.romaji,server:stream.server,ms:Date.now()-begin,host:new URL(stream.url).hostname,tracks:stream.subtitleTracks.length}));
 }
 const stream=streams[0];
 session.defaultSession.webRequest.onBeforeSendHeaders((details,callback)=>callback({requestHeaders:{...details.requestHeaders,...stream.headers}}));
 const html=`<!doctype html><video id="video" muted></video><script src="${pathToFileURL(path.join(root,'node_modules/hls.js/dist/hls.min.js')).href}"></script>`;
 const file=path.join(dir,'player.html');fs.writeFileSync(file,html);
 const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});await win.loadFile(file);
 const result=await win.webContents.executeJavaScript(`new Promise(resolve=>{const video=document.querySelector('video'),hls=new Hls({enableWorker:false,maxBufferLength:20});let buffered=0;const finish=value=>{clearTimeout(timer);hls.destroy();resolve(value)};const timer=setTimeout(()=>finish({ok:false,error:'timeout',buffered}),45000);hls.on(Hls.Events.FRAG_BUFFERED,()=>{buffered++;if(buffered>=3)finish({ok:true,buffered,levels:hls.levels.map(x=>x.height)})});hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal)finish({ok:false,error:data.details,buffered})});hls.loadSource(${JSON.stringify(stream.url)});hls.attachMedia(video);video.play().catch(()=>{});})`);
 assert.equal(result.ok,true,JSON.stringify(result));console.log('Native HLS segments:',JSON.stringify(result));
 assert.equal(popupWindows,0);console.log('Unwanted popup windows:',popupWindows);
 win.destroy();app.quit();
}).catch(error=>{console.error(error.stack||error);app.exit(1)});

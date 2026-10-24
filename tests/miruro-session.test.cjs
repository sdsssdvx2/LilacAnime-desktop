const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createMiruroSession,isChallenge}=require('../electron/miruro-session.cjs');
const challenge=()=>new Response('<html>Just a moment /cdn-cgi/challenge-platform/</html>',{status:403,headers:{'content-type':'text/html','cf-mitigated':'challenge'}});
function fixture({cancel=false,blocked=false,fail=false,download=false}={}){
 let verified=false, windows=0, calls=0, loadedUrl='', prevented=false;
 class Window extends EventEmitter {
   constructor(options){super();windows++;assert.equal(options.webPreferences.partition,'persist:lilac-miruro');assert.equal(options.webPreferences.nodeIntegration,false);this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
   isDestroyed(){return Boolean(this.dead)}
   destroy(){this.dead=true;this.emit('closed')}
   async loadURL(url){loadedUrl=url;setImmediate(()=>{if(cancel)this.destroy();else if(fail)this.webContents.emit('did-fail-load',{},-105,'ERR_NAME_NOT_RESOLVED',url,true);else{verified=true;if(download)ses.emit('will-download',{preventDefault(){prevented=true}}, {},this.webContents);else this.webContents.emit('did-finish-load')}})}
 }
 const ses=Object.assign(new EventEmitter(),{fetch:async(url,options)=>{calls++;assert.equal(options.credentials,'include');return verified&&!blocked?new Response('catalog bytes'):challenge()}});
 const request=createMiruroSession({session:{fromPartition:p=>{assert.equal(p,'persist:lilac-miruro');return ses}},BrowserWindow:Window});
 return {request,windows:()=>windows,calls:()=>calls,loadedUrl:()=>loadedUrl,prevented:()=>prevented,ses};
}
test('detect challenge without treating all 403 responses as verification',()=>{
 assert.equal(isChallenge(challenge(),Buffer.from('')),true);
 assert.equal(isChallenge(new Response('Forbidden',{status:403}),Buffer.from('Forbidden')),false);
 assert.equal(isChallenge(new Response('',{headers:{'content-type':'text/html'}}),Buffer.from('cf-chl-test')),true);
});
test('a Cloudflare block page does not open an unsolvable verification window',async()=>{
 let windows=0;
 const request=createMiruroSession({session:{fromPartition:()=>({fetch:async()=>new Response('Sorry, you have been blocked',{status:403,headers:{'content-type':'text/html'}})})},BrowserWindow:class{constructor(){windows++}}});
 await assert.rejects(request('https://www.miruro.to/api/v1/anime'),e=>e.permanent&&/인증으로 해제할 수/.test(e.message));
 assert.equal(windows,0);
});
test('concurrent blocked requests share a verification window and retry with its session',async()=>{
 const f=fixture();
 const results=await Promise.all([f.request('https://www.miruro.to/api/v1/anime'),f.request('https://www.miruro.to/api/v1/schedule')]);
 assert.equal(f.windows(),1);
 assert.equal(f.loadedUrl(),'https://www.miruro.to/api/v1/anime');
 for(const result of results){assert.equal(result.response.status,200);assert.equal(result.body.toString(),'catalog bytes')}
 await f.request('https://www.miruro.to/api/v1/anime');assert.equal(f.windows(),1);
});
test('page load failure closes verification and reports the network error',async()=>{
 const f=fixture({fail:true});
 await assert.rejects(f.request('https://www.miruro.to/api/v1/anime'),e=>e.permanent&&/ERR_NAME_NOT_RESOLVED/.test(e.message));
 assert.equal(f.ses.listenerCount('will-download'),0);
});
test('successful binary API navigation is not saved as a download',async()=>{
 const f=fixture({download:true});
 const result=await f.request('https://www.miruro.to/api/v1/anime');
 assert.equal(result.response.status,200);assert.equal(f.prevented(),true);
 assert.equal(f.ses.listenerCount('will-download'),0);
});
test('closing verification stops retries and suppresses immediate repeat windows',async()=>{
 const f=fixture({cancel:true});
 await assert.rejects(f.request('https://www.miruro.to/api/v1/anime'),e=>e.permanent&&/닫았습니다/.test(e.message));
 await assert.rejects(f.request('https://www.miruro.to/api/v1/anime'),e=>e.permanent);
 assert.equal(f.windows(),1);
});

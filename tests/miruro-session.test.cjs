const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createMiruroSession,isChallenge}=require('../electron/miruro-session.cjs');
const challenge=()=>new Response('<html>Just a moment /cdn-cgi/challenge-platform/</html>',{status:403,headers:{'content-type':'text/html','cf-mitigated':'challenge'}});
function fixture({cancel=false,blocked=false}={}){
 let verified=false, windows=0, calls=0;
 class Window extends EventEmitter {
   constructor(options){super();windows++;assert.equal(options.webPreferences.partition,'persist:lilac-miruro');assert.equal(options.webPreferences.nodeIntegration,false);this.webContents=new EventEmitter();this.webContents.setWindowOpenHandler=()=>{};}
   isDestroyed(){return Boolean(this.dead)}
   destroy(){this.dead=true;this.emit('closed')}
   async loadURL(){setImmediate(()=>{if(cancel)this.destroy();else{verified=true;this.webContents.emit('did-finish-load')}})}
 }
 const ses={fetch:async(url,options)=>{calls++;assert.equal(options.credentials,'include');return verified&&!blocked?new Response('catalog bytes'):challenge()}};
 const request=createMiruroSession({session:{fromPartition:p=>{assert.equal(p,'persist:lilac-miruro');return ses}},BrowserWindow:Window});
 return {request,windows:()=>windows,calls:()=>calls};
}
test('detect challenge without treating all 403 responses as verification',()=>{
 assert.equal(isChallenge(challenge(),Buffer.from('')),true);
 assert.equal(isChallenge(new Response('Forbidden',{status:403}),Buffer.from('Forbidden')),false);
 assert.equal(isChallenge(new Response('',{headers:{'content-type':'text/html'}}),Buffer.from('cf-chl-test')),true);
});
test('concurrent blocked requests share a verification window and retry with its session',async()=>{
 const f=fixture();
 const results=await Promise.all([f.request('https://www.miruro.to/api/v1/anime'),f.request('https://www.miruro.to/api/v1/schedule')]);
 assert.equal(f.windows(),1);
 for(const result of results){assert.equal(result.response.status,200);assert.equal(result.body.toString(),'catalog bytes')}
 await f.request('https://www.miruro.to/api/v1/anime');assert.equal(f.windows(),1);
});
test('closing verification stops retries and suppresses immediate repeat windows',async()=>{
 const f=fixture({cancel:true});
 await assert.rejects(f.request('https://www.miruro.to/api/v1/anime'),e=>e.permanent&&/닫았습니다/.test(e.message));
 await assert.rejects(f.request('https://www.miruro.to/api/v1/anime'),e=>e.permanent);
 assert.equal(f.windows(),1);
});

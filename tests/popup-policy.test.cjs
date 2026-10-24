const {test}=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {installPopupBlocker}=require('../electron/popup-policy.cjs');

test('every new webContents denies page popups, without changing session permissions',()=>{
 const app=new EventEmitter();installPopupBlocker(app);
 for(const kind of ['main','hidden resolver','external player','authentication','subtitle viewer']){
  let handler;
  const contents={setWindowOpenHandler:fn=>{handler=fn},session:new Proxy({}, {get(){throw Error('permission handling must remain unchanged')}})};
  app.emit('web-contents-created',{},contents);
  assert.equal(typeof handler,'function',kind);
  for(const details of [
   {url:'https://ads.example/ad',disposition:'new-window'},
   {url:'https://ads.example/ad',disposition:'foreground-tab'},
   {url:'about:blank',disposition:'new-window'}
  ])assert.deepEqual(handler(details),{action:'deny'});
 }
});

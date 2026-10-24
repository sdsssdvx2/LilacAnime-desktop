'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MiniPlayerWindowController } = require('../electron/miniplayer-window.cjs');

class FakeWindow extends EventEmitter {
  constructor({ fullscreen=false, maximized=false }={}) {
    super(); this.destroyed=false; this.fullscreen=fullscreen; this.maximized=maximized;
    this.bounds={x:120,y:80,width:1440,height:900}; this.min=[980,680]; this.always=false; this.resizable=true;
    this.boundsHistory=[]; this.alwaysHistory=[];
  }
  isDestroyed(){return this.destroyed} getNormalBounds(){return {...this.bounds}} getBounds(){return {...this.bounds}}
  isMaximized(){return this.maximized} maximize(){this.maximized=true;this.emit('maximize')} unmaximize(){this.maximized=false;this.emit('unmaximize')}
  isFullScreen(){return this.fullscreen} setFullScreen(v){this.fullscreen=Boolean(v);queueMicrotask(()=>this.emit(v?'enter-full-screen':'leave-full-screen'))}
  isAlwaysOnTop(){return this.always} setAlwaysOnTop(v){this.always=Boolean(v);this.alwaysHistory.push(this.always)}
  getMinimumSize(){return [...this.min]} setMinimumSize(w,h){this.min=[w,h]}
  isResizable(){return this.resizable} setResizable(v){this.resizable=Boolean(v)}
  setBounds(b){this.bounds={...b};this.boundsHistory.push({...b})}
  show(){} focus(){}
}
const screen={
  getDisplayMatching:()=>({workArea:{x:0,y:0,width:1920,height:1040}}),
  getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1920,height:1040}})
};

(async()=>{
  const controller=new MiniPlayerWindowController({screen});
  const win=new FakeWindow({fullscreen:true});
  const original={...win.bounds};
  let result=await controller.set(win,true);
  assert.equal(result.active,true); assert.equal(controller.active(win),true); assert.equal(win.__lilacMiniPlayer,true);
  assert.equal(win.fullscreen,false); assert.equal(win.always,true); assert.deepEqual(win.min,[320,180]);
  assert.ok(result.bounds.width<=640 && result.bounds.width>=480); assert.ok(Math.abs(result.bounds.width/result.bounds.height-16/9)<0.02);
  assert.equal(result.bounds.x+result.bounds.width,1904); assert.equal(result.bounds.y+result.bounds.height,1024);
  const first={...result.bounds};
  result=await controller.set(win,true); assert.deepEqual(result.bounds,first); assert.equal(win.boundsHistory.length,1,'re-enter must not resize again');
  result=await controller.set(win,false); assert.equal(result.active,false); assert.equal(controller.active(win),false); assert.equal(win.__lilacMiniPlayer,false);
  assert.equal(win.fullscreen,true); assert.equal(win.always,false); assert.deepEqual(win.min,[980,680]); assert.deepEqual(win.bounds,original);

  const maxWin=new FakeWindow({maximized:true});
  await controller.set(maxWin,true); assert.equal(maxWin.maximized,false); await controller.set(maxWin,false); assert.equal(maxWin.maximized,true);
  console.log('LIBMPV_R2T_MINIPLAYER_WINDOW_PASS fullscreenRestore=1 maximizeRestore=1 boundsRestore=1 alwaysOnTop=1 aspect=16:9');
})().catch(error=>{console.error(error?.stack||error);process.exitCode=1});

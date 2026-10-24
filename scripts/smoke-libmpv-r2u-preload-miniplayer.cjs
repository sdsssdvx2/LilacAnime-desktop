'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {app,BrowserWindow,ipcMain}=require('electron');
const root=path.resolve(__dirname,'..'),fixture=path.join(os.tmpdir(),`lilac-r2u-preload-${process.pid}.html`);let failed=false,calls=[];
function fail(m,d){failed=true;console.error('LIBMPV_R2U_PRELOAD_FAIL '+m);if(d)console.error(JSON.stringify(d,null,2))}
(async()=>{await app.whenReady();fs.writeFileSync(fixture,'<!doctype html><meta charset="utf-8"><title>r2u preload</title>');
ipcMain.removeHandler('player:miniplayer');ipcMain.handle('player:miniplayer',(_event,enabled)=>{calls.push(Boolean(enabled));return{active:Boolean(enabled)}});
const win=new BrowserWindow({show:false,width:640,height:360,webPreferences:{preload:path.join(root,'electron','preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:false}});
try{await win.loadFile(fixture);const result=await win.webContents.executeJavaScript(`(async()=>({type:typeof window.lilac?.setMiniPlayer,on:await window.lilac.setMiniPlayer(true),off:await window.lilac.setMiniPlayer(false)}))()`);if(result.type!=='function'||result.on?.active!==true||result.off?.active!==false||JSON.stringify(calls)!=='[true,false]')fail('actual preload IPC bridge mismatch',{result,calls});else console.log('LIBMPV_R2U_PRELOAD_PASS setMiniPlayer=function calls=true,false');}
catch(e){fail(String(e?.stack||e))}finally{ipcMain.removeHandler('player:miniplayer');if(!win.isDestroyed())win.destroy();try{fs.rmSync(fixture,{force:true})}catch{}app.exit(failed?1:0)}})().catch(e=>{console.error(e?.stack||e);app.exit(1)});

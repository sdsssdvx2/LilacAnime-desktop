const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {installPopupBlocker}=require('../electron/popup-policy.cjs');
installPopupBlocker(app);
app.whenReady().then(async()=>{
 let win,player;
 const deadline=setTimeout(()=>{console.error('popup check timeout');app.exit(1)},15000);
 try {
  win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  let opened=0;win.webContents.on('did-create-window',()=>opened++);
  await win.loadURL('data:text/html,'+encodeURIComponent('<a id="ad" target="_blank" href="https://ads.example/">ad</a><iframe srcdoc="<p>ad iframe</p>"></iframe>'));
  assert.equal(await win.webContents.executeJavaScript(`window.open('https://ads.example/')===null`,true),true);
  await win.webContents.executeJavaScript(`document.getElementById('ad').click()`,true);
  const frame=win.webContents.mainFrame.frames[0];assert.ok(frame);
  assert.equal(await frame.executeJavaScript(`window.open('https://ads.example/')===null`,true),true);
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(opened,0);assert.equal(BrowserWindow.getAllWindows().length,1);
  player=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
  assert.equal(BrowserWindow.getAllWindows().length,2);
  console.log('PASS: window.open, target=_blank and iframe popups blocked; app-created windows allowed');
 }catch(error){console.error(error);app.exitCode=1}
 finally{clearTimeout(deadline);player?.destroy();win?.destroy();app.exit(app.exitCode||0)}
});

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('enable-features', 'Vulkan');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-vulkan', 'swiftshader');
app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
app.commandLine.appendSwitch('disable-vulkan-surface');

function listenLocalhost() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><canvas id="src" width="64" height="64"></canvas><canvas id="dst" width="64" height="64"></canvas>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await listenLocalhost();
  await app.whenReady();
  const address = server.address();
  const win = new BrowserWindow({ show: false, width: 640, height: 360, webPreferences: { contextIsolation: true, sandbox: true } });
  try {
    await win.loadURL(`http://127.0.0.1:${address.port}/`);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const contextInfo={isSecureContext,origin:location.origin};
      if(!navigator.gpu)return {status:'unavailable',reason:'navigator.gpu-unavailable',contextInfo};
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter)return {status:'unavailable',reason:'adapter-unavailable',contextInfo};
      const device=await adapter.requestDevice();
      const src=document.querySelector('#src');
      const sctx=src.getContext('2d');
      sctx.fillStyle='rgb(48,96,192)';sctx.fillRect(0,0,64,64);
      const dst=document.querySelector('#dst');
      const context=dst.getContext('webgpu');
      if(!context)return {status:'error',reason:'webgpu-context-unavailable',contextInfo};
      const format=navigator.gpu.getPreferredCanvasFormat();
      context.configure({device,format,alphaMode:'opaque',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
      const started=performance.now();
      let copies=0;
      for(let i=0;i<120;i+=1){
        device.queue.copyExternalImageToTexture({source:src},{texture:context.getCurrentTexture()},{width:64,height:64,depthOrArrayLayers:1});
        copies+=1;
        if(i%30===29)await device.queue.onSubmittedWorkDone();
      }
      await device.queue.onSubmittedWorkDone();
      return {status:'ok',copies,elapsed:performance.now()-started,contextInfo,format};
    })()`);
    assert.equal(result?.contextInfo?.isSecureContext, true, `probe origin not secure: ${JSON.stringify(result?.contextInfo)}`);
    if (result?.status === 'unavailable') {
      console.log(`LIBMPV_R2Z_WEBGPU_DIRECT_RUNTIME_UNAVAILABLE reason=${result.reason}`);
      return;
    }
    assert.equal(result?.status, 'ok', result?.reason || 'direct WebGPU canvas copy failed');
    assert.equal(result.copies, 120);
    assert.ok(Number.isFinite(result.elapsed));
    console.log('LIBMPV_R2Z_WEBGPU_DIRECT_RUNTIME_OK', JSON.stringify(result));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise(resolve => server.close(resolve));
    app.quit();
  }
})().catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');

// Test-process-only switches. Production Lilac does not receive these flags.
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
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><body style="margin:0;background:black"><canvas id="c" width="64" height="64"></canvas></body>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await listenLocalhost();
  await app.whenReady();
  const address = server.address();
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  try {
    await win.loadURL(`http://127.0.0.1:${address.port}/`);
    const result = await win.webContents.executeJavaScript(`(async()=>{
      const contextInfo={isSecureContext,origin:location.origin,protocol:location.protocol};
      if(!navigator.gpu)return {status:'unavailable',reason:'navigator.gpu-unavailable',contextInfo};
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter)return {status:'unavailable',reason:'adapter-unavailable',contextInfo};
      const info=adapter.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}:{};
      const device=await adapter.requestDevice();
      const canvas=document.querySelector('#c');
      const context=canvas.getContext('webgpu');
      if(!context)return {status:'error',reason:'webgpu-context-unavailable',contextInfo};
      const format=navigator.gpu.getPreferredCanvasFormat();
      const usage=GPUTextureUsage;
      context.configure({device,format,alphaMode:'opaque',usage:usage.COPY_DST|usage.RENDER_ATTACHMENT});
      const staging=device.createTexture({
        size:{width:64,height:64,depthOrArrayLayers:1},
        format,
        usage:usage.COPY_DST|usage.COPY_SRC|usage.RENDER_ATTACHMENT
      });
      const bytes=new Uint8Array(64*64*4);
      for(let i=0;i<bytes.length;i+=4){bytes[i]=48;bytes[i+1]=96;bytes[i+2]=192;bytes[i+3]=255}
      device.queue.writeTexture({texture:staging},bytes,{bytesPerRow:256,rowsPerImage:64},{width:64,height:64,depthOrArrayLayers:1});
      const before=performance.now();
      const rafAt=await new Promise(resolve=>requestAnimationFrame(resolve));
      const encoder=device.createCommandEncoder();
      encoder.copyTextureToTexture({texture:staging},{texture:context.getCurrentTexture()},{width:64,height:64,depthOrArrayLayers:1});
      device.queue.submit([encoder.finish()]);
      await device.queue.onSubmittedWorkDone();
      const elapsed=performance.now()-before;
      staging.destroy();
      return {status:'ok',rafAt,elapsed,format,adapter:info,contextInfo};
    })()`);

    assert.equal(result?.contextInfo?.isSecureContext, true, `probe origin was not secure: ${JSON.stringify(result?.contextInfo)}`);
    if (result?.status === 'unavailable') {
      console.log(`LIBMPV_R2X_WEBGPU_STAGING_RUNTIME_UNAVAILABLE reason=${result.reason} secure=true origin=${result.contextInfo.origin}`);
      return;
    }
    assert.equal(result?.status, 'ok', result?.reason || 'WebGPU staged presentation failed');
    assert.ok(Number.isFinite(result.rafAt));
    assert.ok(Number.isFinite(result.elapsed));
    console.log('LIBMPV_R2X_WEBGPU_STAGING_RUNTIME_OK', JSON.stringify(result));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await new Promise(resolve => server.close(resolve));
    app.quit();
  }
})().catch(error => {
  console.error(error);
  app.exit(1);
});

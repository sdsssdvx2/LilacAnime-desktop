'use strict';

const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');

// GitHub-hosted Windows runners expose no physical graphics adapter. Chromium
// supports explicit SwiftShader/Dawn opt-in for GPU-less WebGPU tests; these
// switches are test-process-only and are never added to the production app.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
app.commandLine.appendSwitch('enable-features', 'Vulkan');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('use-vulkan', 'swiftshader');
app.commandLine.appendSwitch('use-webgpu-adapter', 'swiftshader');
app.commandLine.appendSwitch('disable-vulkan-surface');

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 360,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  try {
    await win.loadURL('data:text/html,<meta charset=utf-8><body style="margin:0;background:black"><canvas id=c width=64 height=64></canvas></body>');
    const result = await win.webContents.executeJavaScript(`(async()=>{
      if(!navigator.gpu)return {ok:false,error:'navigator.gpu unavailable'};
      const adapter=await navigator.gpu.requestAdapter();
      if(!adapter)return {ok:false,error:'adapter unavailable'};
      const info=adapter.info?{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description}:{};
      const device=await adapter.requestDevice();
      const canvas=document.querySelector('#c');
      const context=canvas.getContext('webgpu');
      if(!context)return {ok:false,error:'webgpu context unavailable'};
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
      return {ok:true,rafAt,elapsed,format,adapter:info};
    })()`);
    assert.equal(result?.ok, true, result?.error || 'WebGPU staged presentation failed');
    assert.ok(Number.isFinite(result.rafAt));
    assert.ok(Number.isFinite(result.elapsed));
    console.log('LIBMPV_R2X_WEBGPU_STAGING_RUNTIME_OK', JSON.stringify(result));
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  }
})().catch(error => {
  console.error(error);
  app.exit(1);
});

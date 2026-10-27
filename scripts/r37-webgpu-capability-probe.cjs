'use strict';

const { app, BrowserWindow } = require('electron');

const timeout = setTimeout(() => {
  console.error('R37_WEBGPU_CAPABILITY_PROBE_TIMEOUT');
  process.exit(124);
}, 30000);
timeout.unref?.();

function compactGpuInfo(info) {
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  return {
    auxAttributes: info?.auxAttributes || null,
    devices: devices.map(device => ({
      vendorId: device?.vendorId,
      deviceId: device?.deviceId,
      vendorString: device?.vendorString,
      deviceString: device?.deviceString,
      driverVendor: device?.driverVendor,
      driverVersion: device?.driverVersion,
      active: device?.active
    }))
  };
}

(async () => {
  await app.whenReady();
  const featureStatus = app.getGPUFeatureStatus?.() || null;
  let gpuInfo = null;
  try { gpuInfo = compactGpuInfo(await app.getGPUInfo('complete')); } catch (error) {
    gpuInfo = { error: String(error?.message || error) };
  }

  const win = new BrowserWindow({
    show: false,
    width: 96,
    height: 96,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, nodeIntegration: false }
  });
  try {
    await win.loadURL('data:text/html,<meta charset="utf-8"><canvas id="c" width="16" height="16"></canvas>');
    const renderer = await win.webContents.executeJavaScript(`(async()=>{
      const out={navigatorGpu:Boolean(navigator.gpu),adapter:false,device:false,format:null,error:null};
      try {
        if(!navigator.gpu){out.error='navigator.gpu unavailable';return out;}
        let adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
        if(!adapter) adapter=await navigator.gpu.requestAdapter();
        if(!adapter){out.error='WebGPU adapter unavailable';return out;}
        out.adapter=true;
        const device=await adapter.requestDevice();
        out.device=Boolean(device);
        const context=document.querySelector('#c').getContext('webgpu');
        if(!context){out.error='webgpu canvas context unavailable';return out;}
        const format=navigator.gpu.getPreferredCanvasFormat();
        out.format=format;
        context.configure({device,format,alphaMode:'opaque'});
        const encoder=device.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:0,b:0,a:1},loadOp:'clear',storeOp:'store'}]});
        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        return out;
      }catch(error){out.error=String(error?.message||error);return out;}
    })()`);
    const payload = { hardwareAcceleration: app.isHardwareAccelerationEnabled?.() !== false, featureStatus, gpuInfo, renderer };
    console.log(`R37_WEBGPU_CAPABILITY_PROBE ${JSON.stringify(payload)}`);
    if (!renderer?.adapter || !renderer?.device || renderer?.error) process.exitCode = 78;
  } finally {
    clearTimeout(timeout);
    try { win.destroy(); } catch {}
    app.quit();
  }
})().catch(error => {
  clearTimeout(timeout);
  console.error(`R37_WEBGPU_CAPABILITY_PROBE_ERROR ${String(error?.stack || error)}`);
  try { app.quit(); } catch {}
  process.exit(1);
});

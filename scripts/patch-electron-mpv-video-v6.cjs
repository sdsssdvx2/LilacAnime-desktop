'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const addon = path.join(
  root,
  'node_modules',
  'electron-mpv-video',
  'native',
  'mpv-addon',
  'src',
  'mpv_addon.cc'
);

let source = fs.readFileSync(addon, 'utf8');

function replaceOnce(needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  }
  source = source.replace(needle, replacement);
}

// Electron's Windows sharedTexture contract for BGRA/RGBA uses an NT shared
// handle without IDXGIKeyedMutex. electron-mpv-video 0.1.1 exports BGRA with a
// keyed mutex and then blocks the Electron main thread on AcquireSync(0, 1000)
// for every frame. On this prototype that produced a black video surface and
// made pause/back IPC appear frozen while audio continued.
replaceOnce(
  '    export_desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;',
  '    export_desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE;',
  'BGRA export texture flags'
);

replaceOnce(
`    hr = d3d_export_texture_->QueryInterface(__uuidof(IDXGIKeyedMutex), reinterpret_cast<void**>(&dx_keyed_mutex_));
    if (FAILED(hr) || !dx_keyed_mutex_) {
      dx_error_ = "QueryInterface(IDXGIKeyedMutex) failed: " + hex_u32(static_cast<unsigned long>(hr));
      destroy_dx_shared_target();
      return false;
    }

`,
  '',
  'BGRA keyed mutex query'
);

replaceOnce(
`    HRESULT copy_hr = dx_keyed_mutex_->AcquireSync(0, 1000);
    if (FAILED(copy_hr)) {
      Napi::Error::New(env, "IDXGIKeyedMutex::AcquireSync failed: " + hex_u32(static_cast<unsigned long>(copy_hr))).ThrowAsJavaScriptException();
      return env.Null();
    }
    d3d_context_->CopyResource(d3d_export_texture_, d3d_interop_texture_);
    d3d_context_->Flush();
    copy_hr = dx_keyed_mutex_->ReleaseSync(0);
    if (FAILED(copy_hr)) {
      Napi::Error::New(env, "IDXGIKeyedMutex::ReleaseSync failed: " + hex_u32(static_cast<unsigned long>(copy_hr))).ThrowAsJavaScriptException();
      return env.Null();
    }
`,
`    // BGRA sharedTexture imports do not use a keyed mutex. Keep a single frame
    // in flight at the JS service layer and flush the D3D copy before handing
    // Electron the NT handle.
    d3d_context_->CopyResource(d3d_export_texture_, d3d_interop_texture_);
    d3d_context_->Flush();
`,
  'BGRA keyed mutex render synchronization'
);

fs.writeFileSync(addon, source);
console.log('Patched electron-mpv-video Windows BGRA shared texture path for Electron sharedTexture.');

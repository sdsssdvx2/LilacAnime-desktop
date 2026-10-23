'use strict';

const fs = require('node:fs');
const path = require('node:path');
const target = path.resolve(__dirname, '..', 'electron', 'libmpv-hardware-qualification.cjs');
let source = fs.readFileSync(target, 'utf8');
const oldMarker = `    gpuCopyRenderer: preload.includes("rendererMode = 'webgpu-copy'") && preload.includes('copyExternalImageToTexture') && !preload.includes("getContext('2d'"),`;
const newMarker = `    gpuCopyRenderer: preload.includes('webgpu-copy') && preload.includes('copyExternalImageToTexture') && !/getContext\\(["']2d["']/.test(preload),`;
const count = source.split(oldMarker).length - 1;
if (count !== 1) throw new Error(`R2H qualification bundle-marker anchor count=${count}`);
source = source.replace(oldMarker, newMarker);
fs.writeFileSync(target, source);
console.log('LIBMPV_R2H_BUNDLE_MARKER_FIX_OK semantic=true');

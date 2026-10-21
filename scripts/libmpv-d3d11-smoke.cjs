'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeBmp(width, height, r, g, b) {
  const rowSize = Math.floor((width * 3 + 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const out = Buffer.alloc(54 + pixelBytes);
  out.write('BM', 0, 2, 'ascii');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) {
    const row = 54 + y * rowSize;
    for (let x = 0; x < width; x += 1) {
      const i = row + x * 3;
      out[i] = b;
      out[i + 1] = g;
      out[i + 2] = r;
    }
  }
  return out;
}

function distance(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

const addonPath = process.env.LILAC_LIBMPV_BRIDGE_ADDON;
const dllPath = process.env.LILAC_LIBMPV_DLL;
if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_BRIDGE_ADDON missing');
if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');

const target = { r: 6, g: 64, b: 230 };
const fixture = path.join(os.tmpdir(), `lilac-libmpv-smoke-${process.pid}.bmp`);
fs.writeFileSync(fixture, makeBmp(256, 144, target.r, target.g, target.b));

try {
  const addon = require(addonPath);
  if (typeof addon.smokeRender !== 'function') throw new Error('smokeRender export missing');
  const result = addon.smokeRender(fixture);
  const colorDistance = distance(result.sample, target);
  const report = {
    schema: 1,
    smoke: 'libmpv D3D11 render -> shared texture',
    electron: process.versions.electron,
    dllName: path.basename(dllPath),
    result,
    expected: target,
    colorDistance,
    pass: Boolean(
      result?.ok &&
      result?.rendered &&
      result?.sharedHandleBytes === 8 &&
      result?.sample?.a >= 240 &&
      colorDistance < 80
    )
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
} finally {
  try { fs.unlinkSync(fixture); } catch {}
}

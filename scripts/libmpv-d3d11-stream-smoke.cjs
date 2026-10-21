'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

function nearest(sample, palette) {
  let best = null;
  for (const entry of palette) {
    const d = distance(sample, entry);
    if (!best || d < best.distance) best = { name: entry.name, distance: d };
  }
  return best;
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_PLAYER_ADDON missing');
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');

  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-libmpv-stream-'));
  const output = path.join(dir, 'fixture.mp4');
  const palette = [
    { name: 'blue', r: 6, g: 64, b: 230 },
    { name: 'purple', r: 154, g: 38, b: 220 },
    { name: 'green', r: 12, g: 176, b: 96 },
    { name: 'orange', r: 230, g: 116, b: 18 }
  ];

  for (let i = 0; i < 16; i += 1) {
    const color = palette[i % palette.length];
    fs.writeFileSync(path.join(dir, `frame-${String(i + 1).padStart(2, '0')}.bmp`), makeBmp(256, 144, color.r, color.g, color.b));
  }

  const encode = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', '8',
    '-i', path.join(dir, 'frame-%02d.bmp'),
    '-c:v', 'mpeg4', '-q:v', '1', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  ], { encoding: 'utf8', windowsHide: true });
  if (encode.status !== 0 || !fs.existsSync(output)) {
    throw new Error(`fixture encode failed: ${String(encode.stderr || '').slice(0, 300)}`);
  }

  const addon = require(addonPath);
  for (const name of ['createPlayer', 'open', 'command', 'poll', 'renderFrame', 'releaseFrame', 'sampleFrame', 'destroyPlayer']) {
    if (typeof addon[name] !== 'function') throw new Error(`missing player bridge export: ${name}`);
  }

  let playerId = null;
  const report = {
    schema: 1,
    smoke: 'persistent libmpv D3D11 dynamic stream + triple-buffer lifetime',
    electron: process.versions.electron,
    create: null,
    renderedFrameCount: 0,
    sampledFrames: [],
    distinctPaletteHits: [],
    backpressureObserved: false,
    stateSamples: [],
    finalState: null,
    pass: false
  };

  try {
    const created = addon.createPlayer();
    playerId = created.playerId;
    report.create = created;
    addon.open(playerId, output);

    const held = [];
    const start = Date.now();
    while (Date.now() - start < 5000 && held.length < 3) {
      const state = addon.poll(playerId);
      if (report.stateSamples.length < 8) report.stateSamples.push(state);
      const frame = addon.renderFrame(playerId, 256, 144);
      if (frame.updated) {
        const sample = addon.sampleFrame(playerId, frame.slotId, frame.frameId);
        const hit = nearest(sample, palette);
        held.push(frame);
        report.sampledFrames.push({ frameId: frame.frameId, slotId: frame.slotId, sample, hit });
        report.renderedFrameCount += 1;
      }
      await sleep(18);
    }
    if (held.length !== 3) throw new Error(`expected 3 held frames, got ${held.length}`);

    const pressureDeadline = Date.now() + 2500;
    while (Date.now() < pressureDeadline && !report.backpressureObserved) {
      addon.poll(playerId);
      const frame = addon.renderFrame(playerId, 256, 144);
      if (frame.backpressure === true) report.backpressureObserved = true;
      await sleep(18);
    }

    for (const frame of held) {
      if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
        throw new Error(`failed to release held frame ${frame.frameId}`);
      }
    }

    const continuationDeadline = Date.now() + 3500;
    while (Date.now() < continuationDeadline && report.renderedFrameCount < 10) {
      const state = addon.poll(playerId);
      const frame = addon.renderFrame(playerId, 256, 144);
      if (frame.updated) {
        const sample = addon.sampleFrame(playerId, frame.slotId, frame.frameId);
        const hit = nearest(sample, palette);
        report.sampledFrames.push({ frameId: frame.frameId, slotId: frame.slotId, sample, hit });
        report.renderedFrameCount += 1;
        if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
          throw new Error(`failed to release frame ${frame.frameId}`);
        }
      }
      if (state.eof && report.renderedFrameCount >= 6) break;
      await sleep(18);
    }

    report.finalState = addon.poll(playerId);
    const hitNames = new Set(
      report.sampledFrames
        .filter(item => item.hit && item.hit.distance < 90)
        .map(item => item.hit.name)
    );
    report.distinctPaletteHits = [...hitNames];
    report.pass = Boolean(
      report.create?.deviceMode === 'hardware' &&
      report.renderedFrameCount >= 6 &&
      report.distinctPaletteHits.length >= 3 &&
      report.backpressureObserved &&
      report.finalState?.renderedFrames >= report.renderedFrameCount &&
      report.finalState?.backpressureDrops >= 1
    );
  } finally {
    if (playerId != null) {
      try { addon.destroyPlayer(playerId); } catch {}
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main().catch(error => {
  console.error(JSON.stringify({ schema: 1, smoke: 'persistent libmpv D3D11 dynamic stream + triple-buffer lifetime', pass: false, error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
});

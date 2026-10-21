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

  // Five seconds at 8fps gives enough distinct frames to occupy all 24 shared
  // texture slots, prove backpressure at slot 25, then continue after release.
  for (let i = 0; i < 40; i += 1) {
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
    schema: 2,
    smoke: 'persistent libmpv D3D11 24-slot lifetime + recovery',
    electron: process.versions.electron,
    create: null,
    renderedFrameCount: 0,
    sampledFrames: [],
    distinctPaletteHits: [],
    heldFrames: 0,
    textureSlotCount: null,
    backpressureObserved: false,
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
    while (Date.now() - start < 7000 && held.length < 24) {
      const state = addon.poll(playerId);
      if (Number.isFinite(Number(state.textureSlotCount))) report.textureSlotCount = Number(state.textureSlotCount);
      const frame = addon.renderFrame(playerId, 256, 144);
      if (frame.updated) {
        // The fixture cycles through four colors. Sampling every fifth retained
        // frame walks every palette phase (1,6,11,16,21) instead of aliasing
        // against the four-frame cycle as the old six-frame sampling did.
        if (held.length % 5 === 0) {
          const sample = addon.sampleFrame(playerId, frame.slotId, frame.frameId);
          const hit = nearest(sample, palette);
          report.sampledFrames.push({ frameId: frame.frameId, slotId: frame.slotId, sample, hit });
        }
        held.push(frame);
        report.renderedFrameCount += 1;
      }
      await sleep(12);
    }
    report.heldFrames = held.length;
    if (report.textureSlotCount !== 24) throw new Error(`expected 24 shared texture slots, got ${report.textureSlotCount}`);
    if (held.length !== 24) throw new Error(`expected 24 held frames, got ${held.length}`);

    const pressureDeadline = Date.now() + 1600;
    while (Date.now() < pressureDeadline && !report.backpressureObserved) {
      addon.poll(playerId);
      const frame = addon.renderFrame(playerId, 256, 144);
      if (frame.backpressure === true) report.backpressureObserved = true;
      await sleep(12);
    }
    if (!report.backpressureObserved) throw new Error('24-slot pool never reported backpressure when fully retained');

    for (const frame of held) {
      if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
        throw new Error(`failed to release held frame ${frame.frameId}`);
      }
    }

    const beforeContinuation = report.renderedFrameCount;
    const continuationDeadline = Date.now() + 2500;
    while (Date.now() < continuationDeadline && report.renderedFrameCount < beforeContinuation + 8) {
      const state = addon.poll(playerId);
      const frame = addon.renderFrame(playerId, 256, 144);
      if (frame.updated) {
        report.renderedFrameCount += 1;
        if (!addon.releaseFrame(playerId, frame.slotId, frame.frameId)) {
          throw new Error(`failed to release continuation frame ${frame.frameId}`);
        }
      }
      if (state.eof && report.renderedFrameCount >= beforeContinuation + 3) break;
      await sleep(12);
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
      report.textureSlotCount === 24 &&
      report.heldFrames === 24 &&
      report.distinctPaletteHits.length >= 3 &&
      report.backpressureObserved &&
      report.renderedFrameCount >= beforeContinuation + 3 &&
      report.finalState?.backpressureDrops >= 1 &&
      Number(report.finalState?.textureSlotsInFlight || 0) === 0
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
  console.error(JSON.stringify({ schema: 2, smoke: 'persistent libmpv D3D11 24-slot lifetime + recovery', pass: false, error: String(error?.stack || error) }, null, 2));
  process.exitCode = 1;
});

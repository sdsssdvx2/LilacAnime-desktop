'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createMpvRelay } = require('../electron/mpv-relay.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function buildHlsFixture(dir) {
  const ffmpeg = require('ffmpeg-static');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('ffmpeg-static binary missing');
  const playlist = path.join(dir, 'muxed.m3u8');
  const segmentPattern = path.join(dir, 'seg-%03d.ts');
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_flags', 'independent_segments',
    '-hls_segment_filename', segmentPattern, playlist
  ];
  let encoded = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (encoded.status !== 0 || !fs.existsSync(playlist)) {
    const fallback = [...args];
    const codecIndex = fallback.indexOf('libx264');
    if (codecIndex >= 0) fallback[codecIndex] = 'mpeg2video';
    const presetIndex = fallback.indexOf('-preset');
    if (presetIndex >= 0) fallback.splice(presetIndex, 4);
    encoded = spawnSync(ffmpeg, fallback, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  }
  if (encoded.status !== 0 || !fs.existsSync(playlist)) {
    throw new Error(`muxed HLS fixture encode failed: ${String(encoded.stderr || '').slice(0, 400)}`);
  }
  return playlist;
}

function headerValue(headers, wanted) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(wanted) || '';
  for (const [key, value] of Object.entries(headers)) if (String(key).toLowerCase() === wanted.toLowerCase()) return String(value);
  return '';
}

function installFixtureFetch(dir) {
  const original = global.fetch;
  global.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'fixture.invalid') {
      throw new Error('relay AV smoke attempted an unexpected upstream');
    }
    const name = path.basename(url.pathname);
    if (!/^(?:muxed\.m3u8|seg-\d{3}\.ts)$/.test(name)) throw new Error('relay AV smoke requested an unexpected fixture resource');
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return new Response('missing fixture', { status: 404 });
    const all = fs.readFileSync(file);
    const contentType = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
    const method = String(init?.method || 'GET').toUpperCase();
    const range = headerValue(init?.headers, 'range');
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-type': contentType, 'content-length': String(all.length), 'accept-ranges': 'bytes' } });
    }
    if (range) {
      const match = range.match(/^bytes=(\d+)-(\d*)$/i);
      if (match) {
        const start = Math.min(all.length, Number(match[1]));
        const requestedEnd = match[2] ? Number(match[2]) : all.length - 1;
        const end = Math.min(all.length - 1, Math.max(start, requestedEnd));
        const body = all.subarray(start, end + 1);
        return new Response(body, { status: 206, headers: {
          'content-type': contentType,
          'content-length': String(body.length),
          'content-range': `bytes ${start}-${end}/${all.length}`,
          'accept-ranges': 'bytes'
        } });
      }
    }
    return new Response(all, { status: 200, headers: { 'content-type': contentType, 'content-length': String(all.length), 'accept-ranges': 'bytes' } });
  };
  return () => { global.fetch = original; };
}

async function main() {
  const addonPath = process.env.LILAC_LIBMPV_PLAYER_ADDON;
  const dllPath = process.env.LILAC_LIBMPV_DLL;
  if (!addonPath || !fs.existsSync(addonPath)) throw new Error('LILAC_LIBMPV_PLAYER_ADDON missing');
  if (!dllPath || !fs.existsSync(dllPath)) throw new Error('LILAC_LIBMPV_DLL missing');
  process.env.LILAC_LIBMPV_TEST_AO_NULL = '1';

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lilac-relay-av-'));
  buildHlsFixture(dir);
  const restoreFetch = installFixtureFetch(dir);
  const relay = createMpvRelay();
  const addon = require(addonPath);
  let playerId = null;

  try {
    const prepared = await relay.prepare('https://fixture.invalid/muxed.m3u8', {}, { hls: true, userAgent: 'Lilac relay AV CI' });
    const created = addon.createPlayer();
    playerId = created.playerId;
    addon.open(playerId, prepared.url);

    let state = null;
    let frames = 0;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      state = addon.poll(playerId);
      const frame = addon.renderFrame(playerId, 640, 360);
      if (frame?.updated) {
        frames += 1;
        addon.releaseFrame(playerId, frame.slotId, frame.frameId);
      }
      const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
      const selectedAudio = tracks.some(track => track?.type === 'audio' && track?.selected === true);
      if (state?.fileLoaded && frames >= 12 && selectedAudio && String(state?.aid || '').toLowerCase() !== 'no') break;
      await sleep(20);
    }

    const relayStats = relay.stats();
    const tracks = Array.isArray(state?.tracks) ? state.tracks : [];
    const audioTracks = tracks.filter(track => track?.type === 'audio');
    const videoTracks = tracks.filter(track => track?.type === 'video');
    if (!state?.fileLoaded) throw new Error(`relayed HLS never loaded: ${state?.lastError || 'no error detail'}`);
    if (frames < 12) throw new Error(`relayed HLS produced too few video frames: ${frames}`);
    if (!audioTracks.length) throw new Error(`relayed muxed AAC track was not enumerated: ${JSON.stringify(tracks)}`);
    if (!audioTracks.some(track => track?.selected === true)) throw new Error(`relayed muxed AAC track was not selected: aid=${state?.aid} tracks=${JSON.stringify(tracks)}`);
    if (String(state?.aid || '').toLowerCase() === 'no') throw new Error('relayed muxed AAC left aid=no');
    if (!videoTracks.length) throw new Error(`relayed video track was not enumerated: ${JSON.stringify(tracks)}`);
    if (Number(relayStats?.segments || 0) < 1) throw new Error(`relay did not proxy any HLS segments: ${JSON.stringify(relayStats)}`);
    if (Number(relayStats?.upstreamErrors || 0) !== 0) throw new Error(`relay observed upstream errors: ${JSON.stringify(relayStats)}`);

    console.log(`LIBMPV_RELAY_AV_REPORT=${JSON.stringify({
      frames,
      aid: state?.aid,
      audioCodec: state?.audioCodec,
      currentAo: state?.currentAo,
      tracks,
      relay: {
        requests: relayStats?.requests,
        playlists: relayStats?.playlists,
        segments: relayStats?.segments,
        upstreamErrors: relayStats?.upstreamErrors
      }
    })}`);
    console.log('LIBMPV_RELAY_MUXED_AUDIO_VIDEO_OK');
  } finally {
    if (playerId != null) {
      try { addon.destroyPlayer(playerId); } catch {}
    }
    try { await relay.close(); } catch {}
    restoreFetch();
    delete process.env.LILAC_LIBMPV_TEST_AO_NULL;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discoverLilacExecutable } from '../lilac/launcher.mjs';

let cachedFfmpeg = undefined;

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export async function discoverLilacFfmpeg() {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  const explicit = String(process.env.LILAC_FFMPEG || '').trim();
  if (explicit && await exists(explicit)) return cachedFfmpeg = explicit;
  try {
    const found = await discoverLilacExecutable({ allowPicker: false });
    if (!found?.path) return cachedFfmpeg = '';
    const root = path.dirname(found.path);
    const names = process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg', 'ffmpeg.exe'];
    const roots = [
      path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static'),
      path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'bin'),
      path.join(root, 'node_modules', 'ffmpeg-static')
    ];
    for (const dir of roots) for (const name of names) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return cachedFfmpeg = candidate;
    }
  } catch {}
  return cachedFfmpeg = '';
}

function headerBlob(headers = {}) {
  const entries = Object.entries(headers || {}).filter(([, value]) => value != null && String(value) !== '');
  return entries.length ? entries.map(([key, value]) => `${key}: ${String(value)}`).join('\r\n') + '\r\n' : '';
}

function durationSeconds(stderr = '') {
  const match = String(stderr).match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function parseFfmpegInspection(stderr = '') {
  const text = String(stderr || '');
  const videoLine = text.split(/\r?\n/).find(line => /Stream #.*Video:/i.test(line)) || '';
  const resolution = videoLine.match(/(?:^|[,\s])(\d{2,5})x(\d{2,5})(?:[\s,]|$)/i);
  const fps = videoLine.match(/(\d+(?:\.\d+)?)\s*fps\b/i);
  const bitrate = videoLine.match(/(\d+(?:\.\d+)?)\s*kb\/s\b/i);
  const codec = videoLine.match(/Video:\s*([^,\s]+)/i);
  return {
    width: resolution ? Number(resolution[1]) : null,
    height: resolution ? Number(resolution[2]) : null,
    frameRate: fps ? Number(fps[1]) : null,
    bitrate: bitrate ? Math.round(Number(bitrate[1]) * 1000) : null,
    codec: codec ? codec[1] : '',
    duration: durationSeconds(text)
  };
}

async function runFfmpeg(args, { timeoutMs = 9000, maxStdout = 8 * 1024 * 1024 } = {}) {
  const ffmpeg = await discoverLilacFfmpeg();
  if (!ffmpeg) throw new Error('Lilac bundled FFmpeg was not found');
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let outBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > maxStdout) {
        try { child.kill(); } catch {}
        finish(new Error('FFmpeg frame output exceeded safety limit'));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', error => finish(error));
    child.on('close', code => {
      const stderr = Buffer.concat(err).toString('utf8');
      if (settled) return;
      if (code !== 0) return finish(new Error(`FFmpeg exited ${code}: ${stderr.slice(-900)}`));
      finish(null, { stdout: Buffer.concat(out), stderr });
    });
  });
}

function inputArgs(url, headers, timeoutMs) {
  const args = ['-hide_banner', '-loglevel', 'info', '-rw_timeout', String(Math.max(1, timeoutMs) * 1000)];
  const blob = headerBlob(headers);
  if (blob) args.push('-headers', blob);
  args.push('-i', String(url));
  return args;
}

export async function inspectMedia(url, { headers = {}, timeoutMs = 9000 } = {}) {
  const args = [...inputArgs(url, headers, timeoutMs), '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'];
  const result = await runFfmpeg(args, { timeoutMs });
  return parseFfmpegInspection(result.stderr);
}

export async function extractGrayFrame(url, {
  headers = {}, time = 60, width = 640, height = 360, timeoutMs = 9000
} = {}) {
  const ffmpeg = await discoverLilacFfmpeg();
  if (!ffmpeg) throw new Error('Lilac bundled FFmpeg was not found');
  const args = ['-hide_banner', '-loglevel', 'error', '-rw_timeout', String(Math.max(1, timeoutMs) * 1000), '-ss', String(Math.max(0, Number(time) || 0))];
  const blob = headerBlob(headers);
  if (blob) args.push('-headers', blob);
  args.push('-i', String(url), '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${width}:${height}:flags=lanczos,format=gray`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-');
  const expected = width * height;
  const result = await runFfmpeg(args, { timeoutMs, maxStdout: expected + 4096 });
  if (result.stdout.length !== expected) throw new Error(`FFmpeg returned ${result.stdout.length} frame bytes; expected ${expected}`);
  return result.stdout;
}

export async function extractGrayFrameSequence(url, {
  headers = {}, start = 52, duration = 17, fps = 1, width = 320, height = 180, timeoutMs = 11000
} = {}) {
  const ffmpeg = await discoverLilacFfmpeg();
  if (!ffmpeg) throw new Error('Lilac bundled FFmpeg was not found');
  const safeStart = Math.max(0, Number(start) || 0);
  const safeDuration = Math.max(1, Math.min(30, Number(duration) || 17));
  const safeFps = Math.max(0.25, Math.min(4, Number(fps) || 1));
  const args = ['-hide_banner', '-loglevel', 'error', '-rw_timeout', String(Math.max(1, timeoutMs) * 1000), '-ss', String(safeStart)];
  const blob = headerBlob(headers);
  if (blob) args.push('-headers', blob);
  args.push(
    '-i', String(url), '-map', '0:v:0', '-t', String(safeDuration),
    '-vf', `fps=${safeFps},scale=${width}:${height}:flags=bilinear,format=gray`,
    '-pix_fmt', 'gray', '-f', 'rawvideo', '-'
  );
  const frameBytes = width * height;
  const maxFrames = Math.ceil(safeDuration * safeFps) + 4;
  const result = await runFfmpeg(args, { timeoutMs, maxStdout: frameBytes * maxFrames + 4096 });
  const count = Math.floor(result.stdout.length / frameBytes);
  if (!count) throw new Error('FFmpeg returned no alignment frames');
  const frames = [];
  for (let index = 0; index < count; index++) {
    const from = index * frameBytes;
    frames.push(result.stdout.subarray(from, from + frameBytes));
  }
  return { frames, start: safeStart, fps: safeFps, width, height };
}

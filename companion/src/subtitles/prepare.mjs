import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function decodeBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) { swapped[i - 2] = buffer[i + 1]; swapped[i - 1] = buffer[i]; }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch {
    try { return new TextDecoder('euc-kr').decode(buffer); }
    catch { return new TextDecoder('utf-8').decode(buffer); }
  }
}

function stamp(ms) {
  const value = Math.max(0, Math.round(ms));
  const h = Math.floor(value / 3600000);
  const m = Math.floor((value % 3600000) / 60000);
  const s = Math.floor((value % 60000) / 1000);
  const x = value % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
}

function htmlEntities(text) {
  return text
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function cleanCueText(text) {
  // Match Lilac's SMI normalization order: physical source line breaks are formatting noise,
  // while <br> / </p> are semantic subtitle line breaks. Flatten the source first so
  // "first<br>\r\nsecond" becomes "first\nsecond", never "first\n\nsecond" (a blank
  // line terminates a WebVTT cue and would make the second line disappear).
  const flattened = String(text || '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return htmlEntities(flattened)
    .split(/\r?\n|\r/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .replace(/-->/g, '→')
    .trim();
}

export function srtToVtt(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r/g, '');
  const blocks = text.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim())) lines.shift();
    const timing = lines.shift() || '';
    const match = timing.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})(.*)$/);
    if (!match) continue;
    const start = `${match[1].padStart(2, '0')}:${match[2]}:${match[3]}.${match[4]}`;
    const end = `${match[5].padStart(2, '0')}:${match[6]}:${match[7]}.${match[8]}`;
    const body = lines.join('\n').trim();
    if (body) cues.push(`${start} --> ${end}${match[9] || ''}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

export function smiToVtt(source) {
  const text = String(source || '').replace(/\r/g, '');
  const sync = [...text.matchAll(/<sync\b[^>]*?start\s*=\s*["']?(\d+)["']?[^>]*>/ig)];
  const cues = [];
  for (let i = 0; i < sync.length; i++) {
    const start = Number(sync[i][1]);
    const bodyStart = sync[i].index + sync[i][0].length;
    const bodyEnd = i + 1 < sync.length ? sync[i + 1].index : text.length;
    const body = cleanCueText(text.slice(bodyStart, bodyEnd));
    if (!body) continue;
    const next = i + 1 < sync.length ? Number(sync[i + 1][1]) : start + 5000;
    const end = Math.max(start + 250, next);
    cues.push(`${stamp(start)} --> ${stamp(end)}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function assTime(value) {
  const match = String(value || '').trim().match(/(\d+):(\d{2}):(\d{2})[.](\d{1,3})/);
  if (!match) return null;
  const fraction = Number(match[4].padEnd(3, '0').slice(0, 3));
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + fraction;
}

function assPlainText(value) {
  return String(value || '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\\N|\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

export function assToVtt(source) {
  const lines = String(source || '').replace(/\r/g, '').split('\n');
  let inEvents = false;
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
  const cues = [];
  for (const line of lines) {
    if (/^\s*\[events\]\s*$/i.test(line)) { inEvents = true; continue; }
    if (/^\s*\[/.test(line) && !/^\s*\[events\]/i.test(line)) { inEvents = false; continue; }
    if (!inEvents) continue;
    const format = line.match(/^\s*format\s*:\s*(.+)$/i);
    if (format) { fields = format[1].split(',').map(x => x.trim().toLowerCase()); continue; }
    const dialogue = line.match(/^\s*dialogue\s*:\s*(.+)$/i);
    if (!dialogue) continue;
    const parts = dialogue[1].split(',');
    if (parts.length < fields.length) continue;
    const values = [];
    for (let i = 0; i < fields.length - 1; i++) values.push(parts.shift());
    values.push(parts.join(','));
    const item = Object.fromEntries(fields.map((field, i) => [field, values[i] ?? '']));
    const start = assTime(item.start), end = assTime(item.end), body = assPlainText(item.text);
    if (start == null || end == null || end <= start || !body) continue;
    cues.push(`${stamp(start)} --> ${stamp(end)}\n${body}`);
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

async function adjacentFonts(filePath) {
  const dir = path.dirname(filePath);
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  return names
    .filter(name => /\.(ttf|otf|ttc|woff2?)$/i.test(name))
    .map(name => pathToFileURL(path.join(dir, name)).href);
}

export async function prepareSubtitle(filePath) {
  const buffer = await fs.readFile(filePath);
  const text = decodeBuffer(buffer);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.vtt') return { path: filePath, vtt: /^WEBVTT/i.test(text.trimStart()) ? text : `WEBVTT\n\n${text}`, ass: null, fonts: [] };
  if (ext === '.srt') return { path: filePath, vtt: srtToVtt(text), ass: null, fonts: [] };
  if (ext === '.smi' || ext === '.sami') return { path: filePath, vtt: smiToVtt(text), ass: null, fonts: [] };
  if (ext === '.ass' || ext === '.ssa') return { path: filePath, vtt: assToVtt(text), ass: text, fonts: await adjacentFonts(filePath) };
  throw new Error(`Unsupported subtitle format: ${ext}`);
}

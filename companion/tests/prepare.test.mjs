import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { srtToVtt, smiToVtt, assToVtt, prepareSubtitle } from '../src/subtitles/prepare.mjs';

function cueBodies(vtt) {
  return String(vtt || '').replace(/\r/g, '').trimEnd().split(/\n{2,}/)
    .map(block => block.split('\n'))
    .filter(lines => lines.some(line => line.includes('-->')))
    .map(lines => lines.slice(lines.findIndex(line => line.includes('-->')) + 1).join('\n'));
}

test('SRT converts comma timestamps to WebVTT', () => {
  const out = srtToVtt('1\r\n00:00:01,250 --> 00:00:03,500\r\n안녕\r\n');
  assert.match(out, /^WEBVTT/);
  assert.match(out, /00:00:01\.250 --> 00:00:03\.500/);
  assert.match(out, /안녕/);
});

test('SMI converts SYNC blocks and HTML entities', () => {
  const out = smiToVtt('<SAMI><BODY><SYNC Start=1000><P Class=KRCC>첫 줄<br>둘째 줄<SYNC Start=2500><P Class=KRCC>&lt;3 사랑해</BODY></SAMI>');
  assert.match(out, /00:00:01\.000 --> 00:00:02\.500/);
  assert.match(out, /첫 줄\n둘째 줄/);
  assert.match(out, /<3 사랑해/);
});

test('SMI keeps Bleach-style second line when <br> is followed by a physical newline', () => {
  const out = smiToVtt('<SAMI><BODY>\r\n<SYNC Start=1000><P Class=KRCC>\r\n트럭이 이 정도로 우리 집안을<br>\r\n덮치고도 전원 무사고라니 말야\r\n<SYNC Start=3000><P Class=KRCC>&nbsp;\r\n</BODY></SAMI>');
  assert.deepEqual(cueBodies(out), ['트럭이 이 정도로 우리 집안을\n덮치고도 전원 무사고라니 말야']);
  assert.doesNotMatch(out, /우리 집안을\n\n덮치고도/);
});

test('SMI multiline normalization is class-agnostic and accepts common br variants', () => {
  const out = smiToVtt('<SAMI><BODY>\r\n'
    + '<SYNC Start=1000><P Class=KRCC>KRCC-1<BR>\r\nKRCC-2\r\n'
    + '<SYNC Start=2000><P Class=EZNE_KRCC>EZNE-1<br/>\nEZNE-2\n'
    + '<SYNC Start=3000><P Class=SUBTTL>SUB-1<br />\r\nSUB-2\r\n'
    + '<SYNC Start=4000><P Class=OTHER>가<br><br>나\r\n'
    + '<SYNC Start=5000><P Class=KRCC>&nbsp;\r\n</BODY></SAMI>');
  assert.deepEqual(cueBodies(out), [
    'KRCC-1\nKRCC-2',
    'EZNE-1\nEZNE-2',
    'SUB-1\nSUB-2',
    '가\n나'
  ]);
});

test('prepareSubtitle on SMI produces the same multiline VTT quality as a ready VTT path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilac-companion-smi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '[KaMi]_(Hi10)_Bleach_-_002_(480p)_(Arigatou).smi');
  await fs.writeFile(file, '<SAMI><BODY>\r\n<SYNC Start=1000><P Class=KRCC>첫 줄<br>\r\n둘째 줄\r\n<SYNC Start=2500><P Class=KRCC>&nbsp;\r\n</BODY></SAMI>', 'utf8');
  const prepared = await prepareSubtitle(file);
  assert.equal(prepared.path, file);
  assert.equal(prepared.ass, null);
  assert.deepEqual(cueBodies(prepared.vtt), ['첫 줄\n둘째 줄']);
  assert.match(prepared.vtt, /^WEBVTT\n\n/);
});

test('ASS dialogue is preserved as plain VTT fallback', () => {
  const ass = `[Script Info]\nTitle: test\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}위쪽\\N둘째`;
  const out = assToVtt(ass);
  assert.match(out, /00:00:01\.000 --> 00:00:03\.500/);
  assert.match(out, /위쪽\n둘째/);
  assert.doesNotMatch(out, /\\an8/);
});

test('ASS preparation exposes adjacent font files as file URLs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilac-companion-ass-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const assPath = path.join(dir, 'episode.ass');
  await fs.writeFile(assPath, '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hello');
  await fs.writeFile(path.join(dir, 'Fancy Font.ttf'), 'not-a-real-font');
  await fs.writeFile(path.join(dir, 'ignore.txt'), 'x');
  const prepared = await prepareSubtitle(assPath);
  assert.equal(prepared.fonts.length, 1);
  assert.match(prepared.fonts[0], /^file:/);
  assert.match(decodeURIComponent(prepared.fonts[0]), /Fancy Font\.ttf$/);
});

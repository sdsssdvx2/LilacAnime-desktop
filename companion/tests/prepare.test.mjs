import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { srtToVtt, smiToVtt, assToVtt, prepareSubtitle } from '../src/subtitles/prepare.mjs';

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

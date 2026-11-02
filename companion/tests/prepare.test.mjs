import test from 'node:test';
import assert from 'node:assert/strict';
import { srtToVtt, smiToVtt, assToVtt } from '../src/subtitles/prepare.mjs';

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

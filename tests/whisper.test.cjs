const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keepLine, quietCut, vttOf } = require('../electron/whisper.cjs');

test('sound captions, made-up endings, loops and one repeated sign are left out', () => {
  const recent = [];
  const kept = ['(音楽)', '♪~', '（拍手）', 'ご視聴ありがとうございました', 'この世は腐ってる', 'この世は腐ってる', 'まったくくだらねえ', 'この世は腐ってる', 'あああああ', '毎日毎日']
    .filter(text => keepLine(text, recent));
  assert.deepEqual(kept, ['この世は腐ってる', 'まったくくだらねえ', '毎日毎日']);
});
test('a piece is cut at the quietest moment between 18 and 30 seconds', () => {
  const samples = new Int16Array(16000 * 40).map((_, i) => Math.round(Math.sin(i / 7) * 8000));
  samples.fill(0, 16000 * 24, 16000 * 24 + 8000); // half a second of silence at 24 s
  const at = quietCut(samples, 18, 30) / 16000;
  assert.ok(at > 24 && at < 24.5, `cut at ${at}`);
});
test('the subtitle is written in time order', () => {
  const vtt = vttOf([{ start: 61.5, end: 63, text: 'B' }, { start: 2, end: 2.1, text: 'A' }]);
  assert.match(vtt, /^WEBVTT\n\n00:00:02\.000 --> 00:00:02\.500\nA\n\n00:01:01\.500 --> 00:01:03\.000\nB\n/);
});

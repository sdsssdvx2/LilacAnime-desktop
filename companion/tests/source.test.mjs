import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMasterPlaylist, parseMediaPlaylist } from '../src/source/hls-probe.mjs';
import { pickAnimeCandidate, pickEpisode } from '../src/source/provider-map.mjs';
import { chooseBestSource, safeAutoSwitchDecision, scanSources } from '../src/source/scout.mjs';
import { bestAlignedSequenceFrame } from '../src/source/visual-quality.mjs';

test('master playlist parses and ranks 1080p ahead of 720p', () => {
  const master = `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1"\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1"\n1080/index.m3u8`;
  const variants = parseMasterPlaylist(master, 'https://cdn.example/master.m3u8');
  assert.equal(variants[0].height, 1080);
  assert.equal(variants[0].url, 'https://cdn.example/1080/index.m3u8');
});

test('media playlist resolves segment URLs', () => {
  const media = `#EXTM3U\n#EXTINF:6.0,\na.ts\n#EXTINF:6.0,\n../b.ts`;
  const segments = parseMediaPlaylist(media, 'https://cdn.example/show/playlist.m3u8');
  assert.deepEqual(segments.map(x => x.url), ['https://cdn.example/show/a.ts', 'https://cdn.example/b.ts']);
});

test('provider anime mapping can use Lilac title aliases', () => {
  const result = pickAnimeCandidate(
    ['약사의 혼잣말', 'The Apothecary Diaries', 'Kusuriya no Hitorigoto'],
    [
      { title: 'Kusuriya no Hitorigoto', year: 2023 },
      { title: 'Kusuriya no Hitorigoto Season 2', year: 2025 }
    ],
    { year: 2023 }
  );
  assert.equal(result.confidence, 'high');
  assert.equal(result.selected?.year, 2023);
});

test('episode mapping finds the requested episode without confusing resolution', () => {
  const episodes = [
    { name: 'Episode 1 1080p', number: 1 },
    { name: 'Show - 09 [1080p]' },
    { name: 'Show - 10 [1080p]' }
  ];
  assert.equal(pickEpisode(episodes, 9)?.name, 'Show - 09 [1080p]');
});

const source = (provider, height, bitrate, stability, failureRate = 0, mappingConfidence = 'high') => ({
  provider,
  ok: true,
  value: {
    provider,
    mappingConfidence,
    probe: {
      quality: { height, bandwidth: bitrate },
      metrics: { stability, failureRate }
    }
  }
});

test('current playing source uses live playback evidence instead of re-resolving the provider episode', async () => {
  let prepareCalls = 0;
  const bridge = {
    async titleVariants() { return []; },
    async resolveTitles() { return []; },
    async prepareEpisodeStream() { prepareCalls++; throw new Error('must not re-resolve current source'); }
  };
  const context = {
    anime: { title: 'Sword of Coming' },
    episode: { provider: 'reanime', number: 1 },
    stream: { url: '' },
    playback: { width: 1920, height: 1080, readyState: 4, bufferedAhead: 8, droppedVideoFrames: 0, totalVideoFrames: 500 }
  };
  const scan = await scanSources(bridge, context, { providers: ['reanime'], sampleCount: 1 });
  assert.equal(prepareCalls, 0);
  assert.equal(scan.results[0]?.ok, true);
  assert.equal(scan.results[0]?.value?.probe?.quality?.height, 1080);
  assert.equal(scan.decision?.selected?.provider, 'reanime');
});

test('visual alignment finds the same frame when another source is shifted by three seconds', () => {
  const anchor = Buffer.from([0, 8, 24, 50, 90, 145, 205, 250]);
  const wrong = Buffer.from([250, 205, 145, 90, 50, 24, 8, 0]);
  const frames = Array.from({ length: 17 }, () => Buffer.from(wrong));
  frames[11] = Buffer.from(anchor); // start 92, target 100 => index 11 is +3 seconds.
  const aligned = bestAlignedSequenceFrame(anchor, { frames, start: 92, fps: 1 }, 100, { maxOffset: 8 });
  assert.ok(aligned);
  assert.equal(aligned.offset, 3);
  assert.ok(aligned.similarity > 0.99);
});

test('visual alignment honors the first-sample offset on later samples', () => {
  const anchor = Buffer.from([0, 8, 24, 50, 90, 145, 205, 250]);
  const wrong = Buffer.from([250, 205, 145, 90, 50, 24, 8, 0]);
  const frames = Array.from({ length: 17 }, () => Buffer.from(wrong));
  frames[1] = Buffer.from(anchor);  // -7 seconds: tempting repeated scene.
  frames[11] = Buffer.from(anchor); // +3 seconds: expected timeline offset.
  const aligned = bestAlignedSequenceFrame(anchor, { frames, start: 92, fps: 1 }, 100, {
    expectedOffset: 3,
    maxOffset: 8,
    offsetTolerance: 2
  });
  assert.ok(aligned);
  assert.equal(aligned.offset, 3);
});

test('unstable higher-quality source is rejected before quality ranking', () => {
  const result = chooseBestSource([
    source('reanime', 1080, 6_000_000, 55),
    source('miruro', 1080, 4_500_000, 96),
    source('ohli24', 720, 3_000_000, 99)
  ]);
  assert.equal(result.selected?.provider, 'miruro');
});

test('near-identical quality prefers the more stable source', () => {
  const result = chooseBestSource([
    source('reanime', 1080, 5_000_000, 82),
    source('miruro', 1080, 4_800_000, 97)
  ]);
  assert.equal(result.selected?.provider, 'miruro');
});

test('safe auto switch allows a clear 1080p over 720p win', () => {
  const results = [
    source('reanime', 720, 3_000_000, 95),
    source('miruro', 1080, 5_000_000, 94)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const decision = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(decision.switch, true);
  assert.equal(decision.reason, 'clear-resolution-win');
  assert.equal(decision.selected?.provider, 'miruro');
});

test('safe auto switch does not choose between stable 1080p sources without visual comparison', () => {
  const results = [
    source('reanime', 1080, 4_500_000, 90),
    source('miruro', 1080, 5_500_000, 96)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const decision = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(decision.switch, false);
  assert.equal(decision.reason, 'same-resolution-needs-visual-compare');
});

test('safe auto switch replaces an unstable source at the same resolution', () => {
  const results = [
    source('reanime', 1080, 5_500_000, 50),
    source('miruro', 1080, 4_500_000, 96)
  ];
  const scan = { results, decision: chooseBestSource(results) };
  const decision = safeAutoSwitchDecision(scan, 'reanime');
  assert.equal(decision.switch, true);
  assert.equal(decision.reason, 'current-unstable');
});

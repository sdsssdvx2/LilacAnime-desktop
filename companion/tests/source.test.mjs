import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMasterPlaylist, parseMediaPlaylist } from '../src/source/hls-probe.mjs';
import { pickAnimeCandidate, pickEpisode } from '../src/source/provider-map.mjs';
import { chooseBestSource } from '../src/source/scout.mjs';

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

const source = (provider, height, bitrate, stability, failureRate = 0) => ({
  provider,
  ok: true,
  value: {
    provider,
    probe: {
      quality: { height, bandwidth: bitrate },
      metrics: { stability, failureRate }
    }
  }
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

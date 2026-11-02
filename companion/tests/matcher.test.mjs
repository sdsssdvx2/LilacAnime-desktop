import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEpisode, extractSeason } from '../src/normalize.mjs';
import { chooseSubtitleMatch, rankSubtitleFiles } from '../src/subtitles/matcher.mjs';

const file = (path, { episode = null, season = null, part = null, titleHints = [] } = {}) => ({
  path, name: path.split(/[\\/]/).pop(), ext: '.smi', size: 1000, mtimeMs: 1,
  parent: '', grandparent: '', episode, season, part, titleHints
});

test('episode parser ignores resolution and accepts common anime naming forms', () => {
  assert.equal(extractEpisode('[SubsPlease] Kusuriya no Hitorigoto - 07 (1080p)'), 7);
  assert.equal(extractEpisode('Show.S01E12.1080p.WEB-DL'), 12);
  assert.equal(extractEpisode('작품명 9화 1080p'), 9);
  assert.equal(extractEpisode('Movie 1080p 10bit'), null);
});

test('season parser recognizes S2, Season 2 and Korean 2기', () => {
  assert.equal(extractSeason('Kusuriya S2 - 07'), 2);
  assert.equal(extractSeason('Kusuriya Season 02'), 2);
  assert.equal(extractSeason('약사의 혼잣말 2기 07화'), 2);
});

test('Lilac-provided English/romaji alias can match a differently named local folder', () => {
  const files = [
    file('D:\\Utility\\자막\\Kusuriya no Hitorigoto\\07.smi', { episode: 7, titleHints: ['Kusuriya no Hitorigoto'] }),
    file('D:\\Utility\\자막\\Other Show\\07.smi', { episode: 7, titleHints: ['Other Show'] })
  ];
  const result = chooseSubtitleMatch({
    anime: { title: '약사의 혼잣말' }, episode: 7,
    aliases: ['The Apothecary Diaries', 'Kusuriya no Hitorigoto'], files
  });
  assert.equal(result.confidence, 'high');
  assert.equal(result.selected?.path, files[0].path);
});

test('season mismatch is heavily penalized', () => {
  const files = [
    file('D:\\Subs\\Show S1\\07.smi', { episode: 7, season: 1, titleHints: ['Show'] }),
    file('D:\\Subs\\Show S2\\07.smi', { episode: 7, season: 2, titleHints: ['Show'] })
  ];
  const ranked = rankSubtitleFiles({ anime: { title: 'Show S1' }, episode: 7, aliases: ['Show'], files });
  assert.equal(ranked[0].file.season, 1);
  assert.ok(ranked[0].score - ranked[1].score > 300);
});

test('equally plausible subtitle files are not auto-applied', () => {
  const files = [
    file('D:\\Subs\\Show\\A 07.smi', { episode: 7, titleHints: ['Show'] }),
    file('D:\\Subs\\Show\\B 07.smi', { episode: 7, titleHints: ['Show'] })
  ];
  const result = chooseSubtitleMatch({ anime: { title: 'Show' }, episode: 7, files });
  assert.equal(result.selected, null);
  assert.equal(result.confidence, 'low');
});

test('a remembered explicit user file always wins', () => {
  const files = [
    file('D:\\Subs\\Show\\A 07.smi', { episode: 7, titleHints: ['Show'] }),
    file('D:\\Subs\\Show\\B 07.smi', { episode: 7, titleHints: ['Show'] })
  ];
  const result = chooseSubtitleMatch({ anime: { title: 'Show' }, episode: 7, files, manual: { path: files[1].path } });
  assert.equal(result.confidence, 'user');
  assert.equal(result.selected?.path, files[1].path);
});

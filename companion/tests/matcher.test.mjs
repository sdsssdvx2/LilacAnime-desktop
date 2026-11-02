import test from 'node:test';
import assert from 'node:assert/strict';
import { extractEpisode, extractSeason, extractYear, extractEpisodeKind } from '../src/normalize.mjs';
import { chooseSubtitleMatch, rankSubtitleFiles } from '../src/subtitles/matcher.mjs';

const file = (path, { episode = null, season = null, part = null, year = null, episodeKind = 'main', titleHints = [] } = {}) => ({
  path, name: path.split(/[\\/]/).pop(), ext: '.smi', size: 1000, mtimeMs: 1,
  parent: '', grandparent: '', episode, season, part, year, episodeKind, titleHints
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

test('year and special-kind parser recognize local folder metadata', () => {
  assert.equal(extractYear('닥터 스톤 4기 SCIENCE FUTURE 파트1 2025'), 2025);
  assert.equal(extractEpisodeKind('이세계 치트 스킬 스페셜 01'), 'special');
  assert.equal(extractEpisodeKind('Show OVA 1'), 'ova');
  assert.equal(extractEpisodeKind('Show S01E01'), 'main');
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

test('Dr. STONE 2019 episode 1 does not prefer S04E01 from 2025', () => {
  const season1 = file('D:\\Utility\\자막\\닥터 스톤 1기 2019\\Dr. STONE S01E01.smi', {
    episode: 1, season: 1, year: 2019, titleHints: ['닥터 스톤 1기 2019', 'Dr. STONE']
  });
  const season4 = file('D:\\Utility\\자막\\닥터 스톤 4기 SCIENCE FUTURE 파트1 2025\\Dr. STONE S04E01.smi', {
    episode: 1, season: 4, part: 1, year: 2025, titleHints: ['닥터 스톤 4기 SCIENCE FUTURE 파트1 2025', 'Dr. STONE']
  });
  const result = chooseSubtitleMatch({ anime: { title: '닥터 스톤', title_english: 'Dr. STONE', year: 2019 }, episode: 1, files: [season4, season1] });
  assert.equal(result.best?.file.path, season1.path);
  assert.equal(result.selected?.path, season1.path);
  assert.ok(result.ranked.find(item => item.file.path === season4.path).reasons.includes('year:mismatch:2025'));
});

test('unrelated same-number episode is not even ranked as a subtitle candidate', () => {
  const drStone = file('D:\\Subs\\Dr STONE S04E01.smi', { episode: 1, season: 4, year: 2025, titleHints: ['Dr STONE'] });
  const result = chooseSubtitleMatch({ anime: { title: 'Completely Different Anime', year: 2026 }, episode: 1, files: [drStone] });
  assert.equal(result.best, undefined);
  assert.equal(result.selected, null);
  assert.equal(result.confidence, 'none');
});

test('a detected special never auto-selects a normal episode with the same number', () => {
  const main = file('D:\\Subs\\Show\\Show 01.smi', { episode: 1, episodeKind: 'main', titleHints: ['Show'] });
  const special = file('D:\\Subs\\Show Special\\Show Special 01.smi', { episode: 1, episodeKind: 'special', titleHints: ['Show Special', 'Show'] });
  const result = chooseSubtitleMatch({ anime: { title: 'Show' }, episode: 1, episodeMeta: { name: 'Special 1' }, aliases: ['Show Specials'], files: [main, special] });
  assert.equal(result.best?.file.path, special.path);
  assert.equal(result.selected?.path, special.path);
  assert.ok(result.ranked.find(item => item.file.path === main.path).reasons.some(reason => reason.startsWith('kind:mismatch:')));
});

test('Special and OVA labels are equivalent for non-main bonus episodes', () => {
  const ova = file('D:\\Utility\\자막\\Iseleve 스페셜\\[SubsPlease] Iseleve - OVA.smi', {
    episode: null, episodeKind: 'ova', titleHints: ['Iseleve 스페셜', 'Iseleve OVA']
  });
  const result = chooseSubtitleMatch({
    anime: { title: '이세계에서 치트 스킬을 얻은 나는 현실 세계에서도 무쌍한다' },
    episode: 1,
    episodeMeta: { name: '스페셜 1' },
    aliases: ['Iseleve', 'I Got a Cheat Skill in Another World'],
    files: [ova]
  });
  assert.ok(result.best?.reasons.some(reason => reason === 'kind:equivalent:ova->special'));
  assert.notEqual(result.best?.score, -489);
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

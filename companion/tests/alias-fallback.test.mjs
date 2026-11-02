import test from 'node:test';
import assert from 'node:assert/strict';
import { stripEpisodeNoise } from '../src/normalize.mjs';
import { reverseResolveLocalAliases, localAliasCandidates, inferStructuralLocalAlias, inferLocalSeasonFromLilacSearch } from '../src/subtitles/alias-fallback.mjs';
import { chooseSubtitleMatch } from '../src/subtitles/matcher.mjs';

const nestedFile = {
  path: 'D:\\Utility\\자막\\검래 1기\\팬자막\\01.smi',
  name: '01.smi',
  ext: '.smi',
  size: 1000,
  mtimeMs: 1,
  parent: '팬자막',
  grandparent: '검래 1기',
  episode: 1,
  season: null,
  part: null,
  year: null,
  episodeKind: 'main',
  titleHints: ['팬자막', stripEpisodeNoise('검래 1기'), '01']
};

const anime = { title: 'Sword of Coming', title_english: 'Sword of Coming', year: 2024, provider: 'reanime' };
const episodeMeta = { number: 1, name: 'Although The Rain Is Gentle', provider: 'reanime' };

test('season metadata is stripped from short Korean subtitle folder titles', () => {
  assert.equal(stripEpisodeNoise('검래 1기'), '검래');
  assert.equal(stripEpisodeNoise('검래 2기 2026'), '검래');
});

test('nested subtitle folders expose the series ancestor instead of only the immediate parent', () => {
  const candidates = localAliasCandidates({ anime, episode: 1, episodeMeta, files: [nestedFile] });
  assert.ok(candidates.some(item => item.query === '검래'));
  assert.ok(!candidates.some(item => item.query === 'Utility'));
  assert.ok(!candidates.some(item => item.query === '팬자막'));
});

test('Lilac provider search is the primary bridge from 검래 to Sword of Coming', async () => {
  let searchCalls = 0;
  let metadataCalls = 0;
  const bridge = {
    async searchProvider(provider, query) {
      searchCalls++;
      if (provider === 'reanime' && query === '검래') return [{ title: 'Sword of Coming', title_english: 'Sword of Coming' }];
      return [];
    },
    async titleVariants() { metadataCalls++; return []; },
    async resolveTitles() { metadataCalls++; return []; }
  };
  const aliases = await reverseResolveLocalAliases(bridge, { anime: { ...anime }, episode: 1, episodeMeta, aliases: [], files: [nestedFile] });
  assert.ok(searchCalls > 0);
  assert.equal(metadataCalls, 0);
  assert.ok(aliases.includes('검래'));
  assert.ok(aliases.includes('Sword of Coming'));
  const match = chooseSubtitleMatch({ anime, episode: 1, episodeMeta, aliases, files: [nestedFile] });
  assert.equal(match.confidence, 'high');
  assert.equal(match.selected?.path, nestedFile.path);
});

test('Lilac search distinguishes 검래 1기 from 검래 2기 and supplies the current season', async () => {
  const season1 = {
    ...nestedFile,
    path: 'D:\\Utility\\자막\\검래 1기\\剑来.E01.srt',
    name: '剑来.E01.srt', parent: '검래 1기', grandparent: '자막', season: 1,
    titleHints: ['검래', '剑来']
  };
  const season2 = {
    ...nestedFile,
    path: 'D:\\Utility\\자막\\검래 2기\\剑来.第二季.E01.srt',
    name: '剑来.第二季.E01.srt', parent: '검래 2기', grandparent: '자막', season: 2,
    titleHints: ['검래', '剑来']
  };
  const current = { ...anime };
  const bridge = {
    async searchProvider(provider, query) {
      if (provider !== 'reanime') return [];
      if (query === '검래') return [{ title: 'Sword of Coming' }];
      if (query === '검래 1기') return [{ title: 'Sword of Coming', year: 2024 }];
      if (query === '검래 2기') return [{ title: 'Sword of Coming Season 2', seasonNumber: 2, year: 2026 }];
      return [];
    },
    async titleVariants() { return []; },
    async resolveTitles() { return []; }
  };

  const aliases = await reverseResolveLocalAliases(bridge, {
    anime: current, episode: 1, episodeMeta, aliases: [], files: [season2, season1]
  });
  assert.ok(aliases.includes('검래'));
  assert.equal(current.companionSeasonNumber, 1);
  const result = chooseSubtitleMatch({ anime: current, episode: 1, episodeMeta, aliases, files: [season2, season1] });
  assert.equal(result.confidence, 'high');
  assert.equal(result.selected?.path, season1.path);
  assert.ok(result.ranked.find(item => item.file.path === season2.path)?.reasons.includes('season:mismatch:2'));
});

test('season resolver refuses a fuzzy season-1 result for a 2기 folder', async () => {
  const season2 = {
    ...nestedFile,
    path: 'D:\\Utility\\자막\\검래 2기\\剑来.第二季.E01.srt',
    parent: '검래 2기', grandparent: '자막', season: 2, titleHints: ['검래']
  };
  const current = { ...anime };
  const bridge = {
    async searchProvider(_provider, query) {
      if (query === '검래 2기') return [{ title: 'Sword of Coming' }];
      return [];
    }
  };
  const season = await inferLocalSeasonFromLilacSearch(bridge, {
    anime: current, episode: 1, episodeMeta, aliases: ['검래'], files: [season2]
  });
  assert.equal(season, null);
  assert.equal(current.companionSeasonNumber, undefined);
});

test('reverse titleVariants can connect 검래 to Sword of Coming and make the local subtitle selectable', async () => {
  const otherAnime = { title: 'Sword of Coming Alternate', title_english: 'Sword of Coming Alternate', year: 2024, provider: 'reanime' };
  const bridge = {
    async titleVariants(query) { return query === '검래' ? ['Sword of Coming Alternate'] : []; },
    async resolveTitles() { return []; },
    async searchProvider() { return []; }
  };
  const aliases = await reverseResolveLocalAliases(bridge, { anime: otherAnime, episode: 1, episodeMeta, aliases: [], files: [nestedFile] });
  assert.ok(aliases.includes('검래'));
  assert.ok(aliases.includes('Sword of Coming Alternate'));
  const match = chooseSubtitleMatch({ anime: otherAnime, episode: 1, episodeMeta, aliases, files: [nestedFile] });
  assert.equal(match.confidence, 'high');
  assert.equal(match.selected?.path, nestedFile.path);
});

test('Lilac resolveTitles can connect a Korean local folder when titleVariants has no answer', async () => {
  const otherAnime = { title: 'Unrelated Service Title', title_english: 'Unrelated Service Title', provider: 'reanime' };
  const bridge = {
    async titleVariants() { return []; },
    async resolveTitles(items) {
      return items.map(item => item.title === '검래'
        ? { key: `${item.provider}:${item.id}`, ko: '검래', en: 'Unrelated Service Title' }
        : { key: `${item.provider}:${item.id}`, ko: '', en: '' });
    },
    async searchProvider() { return []; }
  };
  const aliases = await reverseResolveLocalAliases(bridge, { anime: otherAnime, episode: 1, episodeMeta, aliases: [], files: [nestedFile] });
  assert.ok(aliases.includes('검래'));
  assert.ok(aliases.includes('Unrelated Service Title'));
});

test('unique season-wide episode structure can identify a local folder without textual title overlap', () => {
  const files = [];
  for (let episode = 1; episode <= 26; episode++) {
    files.push({
      path: `D:\\Utility\\자막\\고유작품 1기\\${String(episode).padStart(2, '0')}.smi`,
      parent: '고유작품 1기', grandparent: '자막', episode, season: 1, part: null, year: null,
      episodeKind: 'main', titleHints: ['고유작품'], mtimeMs: episode
    });
  }
  for (let episode = 1; episode <= 12; episode++) {
    files.push({
      path: `D:\\Utility\\자막\\다른작품 1기\\${String(episode).padStart(2, '0')}.smi`,
      parent: '다른작품 1기', grandparent: '자막', episode, season: 1, part: null, year: null,
      episodeKind: 'main', titleHints: ['다른작품'], mtimeMs: episode
    });
  }
  const structuralAnime = {
    title: 'A Totally Different English Name',
    companionSeriesEpisodes: Array.from({ length: 26 }, (_, index) => ({ number: index + 1 }))
  };
  const inferred = inferStructuralLocalAlias({ anime: structuralAnime, episode: 1, episodeMeta: { number: 1 }, files });
  assert.equal(inferred?.confidence, 'high');
  assert.equal(inferred?.query, '고유작품');
  assert.equal(inferred?.overlap, 26);
});

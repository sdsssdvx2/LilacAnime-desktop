import test from 'node:test';
import assert from 'node:assert/strict';
import { reverseResolveLocalAliases, localAliasCandidates } from '../src/subtitles/alias-fallback.mjs';
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
  titleHints: ['팬자막', '검래 1기', '01']
};

const anime = { title: 'Sword of Coming', title_english: 'Sword of Coming', year: 2024 };
const episodeMeta = { number: 1, name: 'Although The Rain Is Gentle' };

test('nested subtitle folders expose the series ancestor instead of only the immediate parent', () => {
  const candidates = localAliasCandidates({ anime, episode: 1, episodeMeta, files: [nestedFile] });
  assert.ok(candidates.some(item => item.query === '검래'));
});

test('reverse titleVariants can connect 검래 to Sword of Coming and make the local subtitle selectable', async () => {
  const bridge = {
    async titleVariants(query) { return query === '검래' ? ['Sword of Coming'] : []; },
    async resolveTitles() { return []; },
    async searchProvider() { return []; }
  };
  const aliases = await reverseResolveLocalAliases(bridge, { anime, episode: 1, episodeMeta, aliases: [], files: [nestedFile] });
  assert.ok(aliases.includes('검래'));
  assert.ok(aliases.includes('Sword of Coming'));
  const match = chooseSubtitleMatch({ anime, episode: 1, episodeMeta, aliases, files: [nestedFile] });
  assert.equal(match.confidence, 'high');
  assert.equal(match.selected?.path, nestedFile.path);
});

test('Lilac resolveTitles can connect a Korean local folder when titleVariants has no answer', async () => {
  const bridge = {
    async titleVariants() { return []; },
    async resolveTitles(items) {
      return items[0]?.title === '검래' ? [{ ko: '검래', en: 'Sword of Coming' }] : [];
    },
    async searchProvider() { return []; }
  };
  const aliases = await reverseResolveLocalAliases(bridge, { anime, episode: 1, episodeMeta, aliases: [], files: [nestedFile] });
  assert.ok(aliases.includes('검래'));
  assert.ok(aliases.includes('Sword of Coming'));
});

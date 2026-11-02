import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceDecisionCache } from '../src/source/decision-cache.mjs';
import { resolveProviderEpisode, resetSourceMappingCacheForTests } from '../src/source/scout.mjs';

test('source decision cache reuses a fresh winner and expires it later', () => {
  const cache = new SourceDecisionCache({ ttlMs: 10_000, retryMs: 2_000 });
  const scan = { decision: { selected: { provider: 'reanime' } }, results: [] };
  cache.remember('show|1', scan, 1_000);
  assert.equal(cache.get('show|1', 5_000)?.scan?.decision?.selected?.provider, 'reanime');
  assert.equal(cache.get('show|1', 11_001), null);
});

test('a provisional quick decision can use a shorter TTL than a deep decision', () => {
  const cache = new SourceDecisionCache({ ttlMs: 10_000, retryMs: 2_000 });
  const scan = { decision: { selected: { provider: 'miruro' } }, results: [] };
  cache.remember('show|1', scan, 1_000, 2_000);
  assert.equal(cache.get('show|1', 2_999)?.scan?.decision?.selected?.provider, 'miruro');
  assert.equal(cache.get('show|1', 3_000), null);
});

test('source decision cache delays only failed rescans', () => {
  const cache = new SourceDecisionCache({ ttlMs: 10_000, retryMs: 2_000 });
  cache.defer('show|1', 1_000);
  assert.equal(cache.canScan('show|1', 2_999), false);
  assert.equal(cache.canScan('show|1', 3_000), true);
});

test('provider mapping is reused for the same series instead of searching aliases again', async () => {
  resetSourceMappingCacheForTests();
  let searches = 0;
  let episodeLists = 0;
  let prepares = 0;
  const bridge = {
    async searchProvider() {
      searches++;
      return [{ id: 'sword-of-coming', title: 'Sword of Coming', provider: 'miruro' }];
    },
    async providerEpisodes() {
      episodeLists++;
      return [{ id: 'miruro-e1', provider: 'miruro', number: 1, name: '1화' }];
    },
    async prepareEpisodeStream(episode) {
      prepares++;
      return { url: `https://example.invalid/${episode.id}.m3u8` };
    }
  };
  const context = {
    anime: { title: 'Sword of Coming', year: 2024 },
    episode: { provider: 'reanime', number: 1 },
    seriesEpisodes: [{ number: 1 }]
  };

  const first = await resolveProviderEpisode(bridge, 'miruro', context, ['Sword of Coming']);
  const second = await resolveProviderEpisode(bridge, 'miruro', context, ['Sword of Coming']);
  assert.equal(first.provider, 'miruro');
  assert.equal(second.mapping, 'cached');
  assert.ok(searches >= 1);
  const searchesAfterFirstResolution = searches;
  assert.equal(episodeLists, 1);
  assert.equal(prepares, 2, 'stream URL is refreshed even when title/episode mapping is cached');

  await resolveProviderEpisode(bridge, 'miruro', context, ['Sword of Coming']);
  assert.equal(searches, searchesAfterFirstResolution, 'cached mapping avoids another provider title search');
  assert.equal(episodeLists, 1, 'cached mapping avoids another episode-list fetch');
});

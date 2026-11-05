import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnimeSourcePolicies, RecentAnimeSources, animeSourceIdentity, managedSourcePlan,
  choosePolicySource, policySwitchDecision } from '../src/source/anime-source-policies.mjs';
import { chooseBestSource, rankSourceResults, safeAutoSwitchDecision, chooseDeepSourceProviders } from '../src/source/scout.mjs';

const anime = { title: '애니 A', title_english: 'Series A', anilistId: 101, season: 'winter', year: 2026 };
const context = (number = 1, provider = 'reanime', baseAnime = anime) => ({
  anime: { ...baseAnime }, episode: { number, provider }, activePlayer: true, playbackSessionId: 42
});
async function create(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilac-anime-rules-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    rules: await new AnimeSourcePolicies(path.join(dir, 'rules.json')).load(),
    recents: new RecentAnimeSources(path.join(dir, 'recents.json'))
  };
}
function probe(provider, { height = 1080, stability = 95, mappingConfidence = 'high' } = {}) {
  return { ok: true, provider, value: {
    provider, mappingConfidence,
    probe: { quality: { height, bandwidth: height * 1000 }, metrics: {
      stability, failureRate: 0, minMbps: 10, p95TtfbMs: 100
    } }
  } };
}
function scan(...rows) {
  return { context: context(), results: rows, decision: chooseBestSource(rows), visual: null };
}
function choose(s, policy) {
  return choosePolicySource(s, policy, { chooseBestSource, rankSourceResults });
}

test('rules use stable catalog identity independent of provider, with a strict title fallback', async t => {
  const { rules } = await create(t);
  const first = context(1, 'reanime');
  assert.equal(animeSourceIdentity(first), 'anilist:101');
  await rules.set(first, 'series', 'exclude', 'reanime');
  assert.deepEqual(rules.resolve(context(2, 'miruro')).excluded, ['reanime']);
  assert.equal(rules.resolve(context(2, 'miruro', { ...anime, anilistId: 102 })), null);
  assert.notEqual(
    animeSourceIdentity(context(1, 'miruro', { title: 'Same', year: 2020 })),
    animeSourceIdentity(context(1, 'miruro', { title: 'Same', year: 2021 }))
  );
});

test('series exclusion and episode preferred rule have correct scope and persist', async t => {
  const { rules } = await create(t);
  await rules.set(context(1), 'series', 'exclude', 'reanime');
  await rules.set(context(1), 'series', 'exclude', 'linkkf');
  await rules.set(context(1), 'episode', 'prefer', 'miruro');
  const ep1 = rules.resolve(context(1, 'linkkf'));
  assert.deepEqual(ep1.excluded.sort(), ['linkkf', 'reanime']);
  assert.equal(ep1.preferred, 'miruro');
  assert.equal(rules.resolve(context(2)).preferred, '');
  assert.equal(rules.list().length, 1);
  const reloaded = await new AnimeSourcePolicies(rules.file).load();
  assert.equal(reloaded.resolve(context(1)).preferred, 'miruro');
  await reloaded.set(context(1), 'episode', 'clear');
  assert.equal(reloaded.resolve(context(1)).preferred, '');
  assert.deepEqual(reloaded.resolve(context(1)).excluded.sort(), ['linkkf', 'reanime']);
  await reloaded.set(context(1), 'series', 'clear');
  assert.equal(reloaded.resolve(context(1)), null);
  assert.equal(reloaded.list().length, 0);
});

test('locked source cannot choose fallback when absent or untrusted', async t => {
  const { rules } = await create(t);
  await rules.set(context(), 'series', 'lock', 'miruro');
  const policy = rules.resolve(context());
  let result = choose(scan(probe('reanime'), probe('miruro', { stability: 98 })), policy);
  assert.equal(result.decision.selected.provider, 'miruro');
  assert.equal(policySwitchDecision(result, 'reanime', policy, safeAutoSwitchDecision).switch, true);
  result = choose(scan(probe('reanime'), probe('miruro', { stability: 35 })), policy);
  assert.equal(result.decision.selected, null);
  assert.equal(policySwitchDecision(result, 'reanime', policy, safeAutoSwitchDecision).switch, false);
});

test('excluded HD stream cannot outrank a safe alternative, and never displaces manual stream', async t => {
  const { rules } = await create(t);
  await rules.set(context(), 'series', 'exclude', 'reanime');
  const policy = rules.resolve(context());
  const raw = scan(probe('reanime', { height: 2160 }), probe('miruro', { height: 1080 }));
  const effective = choose(raw, policy);
  assert.equal(effective.decision.selected.provider, 'miruro');
  assert.equal(policySwitchDecision(effective, 'reanime', policy, safeAutoSwitchDecision).switch, true);
  assert.equal(policySwitchDecision(effective, 'miruro', policy, safeAutoSwitchDecision).switch, false);
  const plan = managedSourcePlan({ providers: ['reanime', 'miruro'], intensive: ['reanime', 'miruro'], signature: 'base' }, policy);
  assert.deepEqual(plan.providers, ['miruro']);
  assert.deepEqual(plan.intensive, ['miruro']);
});

test('prefer does not allow unstable or low-confidence automatic source switching', async t => {
  const { rules } = await create(t);
  await rules.set(context(), 'series', 'prefer', 'miruro');
  const policy = rules.resolve(context());
  const raw = scan(probe('reanime', { height: 1080 }), probe('miruro', { height: 2160, stability: 30 }));
  const effective = choose(raw, policy);
  assert.equal(effective.decision.selected.provider, 'reanime');
  assert.equal(policySwitchDecision(effective, 'reanime', policy, safeAutoSwitchDecision).switch, false);
  const lowConfidence = choose(scan(probe('reanime'), probe('miruro', { mappingConfidence: 'low' })), policy);
  assert.notEqual(lowConfidence.decision.reason, 'anime-preferred-source');
});

test('corrupt policies are left unchanged and invalid IDs are rejected', async t => {
  const { rules } = await create(t);
  await assert.rejects(rules.set(context(), 'series', 'prefer', '__proto__'), /Invalid provider ID/);
  await rules.set(context(), 'series', 'prefer', 'miruro');
  await fs.writeFile(rules.file, '{bad');
  await assert.rejects(rules.set(context(), 'series', 'clear'), /preserving file/);
  assert.equal(await fs.readFile(rules.file, 'utf8'), '{bad');
});

test('recent-anime history is private, offline and survives leaving the player', async t => {
  const { recents } = await create(t);
  const viewed = { ...context(), stream: { url: 'https://example.test/token=secret' }, episode: {
    number: 7, provider: 'reanime', token: 'secret'
  } };
  await recents.record(viewed);
  await recents.record({ ...context(4, 'miruro'), activePlayer: false });
  const text = await fs.readFile(recents.file, 'utf8');
  assert.doesNotMatch(text, /secret|example\.test/);
  const list = await recents.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].episode.number, 7);
  assert.ok(animeSourceIdentity(list[0]));
});

test('anime-preferred provider gets a bounded deep slot even with lower measured resolution', () => {
  const quick = scan(
    probe('normal2160', { height: 2160 }),
    probe('focus1080', { height: 1080 }),
    probe('focus1440', { height: 1440 }),
    probe('miruro', { height: 720 })
  );
  const ordinary = chooseDeepSourceProviders(quick, {
    count: 3, intensiveProviders: ['focus1080', 'focus1440']
  });
  const explicit = chooseDeepSourceProviders(quick, {
    count: 3, intensiveProviders: ['focus1080', 'focus1440'], preferredProvider: 'miruro'
  });
  assert.equal(ordinary.length, 3);
  assert.equal(ordinary.includes('miruro'), false);
  assert.equal(explicit.length, 3);
  assert.equal(explicit.includes('miruro'), true);
  assert.equal(explicit[0], 'normal2160');
  assert.deepEqual(chooseDeepSourceProviders(quick, {
    count: 3, preferredProvider: 'missing'
  }).length, 3);
});

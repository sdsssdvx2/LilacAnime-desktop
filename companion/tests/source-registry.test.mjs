import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { SourceRegistry, normaliseSourceSnapshot, validProviderId } from '../src/source/source-registry.mjs';
import { LilacBridge } from '../src/lilac/bridge.mjs';
import { chooseDeepSourceProviders, scanSources } from '../src/source/scout.mjs';

const snapshot = (...items) => ({ reliable: true, providers: items.map(([id, label]) => ({ id, label })) });
async function create(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lilac-sources-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let now = 100000;
  const registry = await new SourceRegistry(path.join(dir, 'registry.json'), { now: () => now }).load();
  return { registry, setNow: value => { now = value; } };
}
function node(value, text) {
  return { value, textContent: text || value, getAttribute: key => key === 'data-value' ? value : null };
}
function fakeBridge({ options = [], buttons = [] } = {}) {
  const document = {
    querySelector: key => key === '#contentSource' && options.length ? {
      querySelectorAll: () => options.map(([id, label]) => node(id, label))
    } : null,
    querySelectorAll: key => key === '#sourceChoices [data-value]' ? buttons.map(([id, label]) => node(id, label)) : []
  };
  return new LilacBridge({ evaluate: source => vm.runInNewContext(source, { document }) });
}

test('reject untrusted snapshots, malformed or unsafe IDs', () => {
  assert.equal(validProviderId('constructor'), false);
  assert.equal(validProviderId('__proto__'), false);
  assert.equal(validProviderId('reanime'), true);
  assert.equal(normaliseSourceSnapshot({ reliable: false, providers: [] }), null);
  assert.equal(normaliseSourceSnapshot(snapshot(['one', 'One'])), null);
  assert.deepEqual(normaliseSourceSnapshot(snapshot(['reanime', 'RE'], ['miruro', 'M'])).map(item => item.id), ['reanime', 'miruro']);
});

test('read real video source selector, not subtitle selector', async () => {
  const bridge = fakeBridge({ options: [['reanime', 'RE:Anime'], ['miruro', 'Miruro']], buttons: [['reanime', 'RE:Anime'], ['miruro', 'Miruro']] });
  const list = await bridge.listProviders();
  assert.equal(list.reliable, true);
  assert.deepEqual([...list.providers].map(item => item.id), ['reanime', 'miruro']);
});

test('detect disagreement between video controls without treating removals as real', async () => {
  const bridge = fakeBridge({ options: [['reanime', 'RE'], ['miruro', 'M']], buttons: [['reanime', 'RE'], ['other', 'Other']] });
  assert.equal((await bridge.listProviders()).reliable, false);
  assert.equal((await fakeBridge().listProviders()).reliable, false);
});

test('new sources inherit normal scan, manual exclusions remain in place', async t => {
  const { registry } = await create(t);
  let result = await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'Miruro']));
  assert.equal(result.initial, true);
  assert.equal(result.changes.length, 0);
  assert.equal(registry.mode('reanime'), 'intensive');
  await registry.setMode('miruro', 'off');
  result = await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'Miruro'], ['brandnew', 'Brand New']));
  assert.deepEqual(result.changes.map(item => item.type), ['added']);
  assert.equal(registry.mode('brandnew'), 'normal');
  assert.equal(registry.mode('miruro'), 'off');
  assert.deepEqual(registry.plan('reanime').providers, ['reanime', 'brandnew']);
});

test('removed, restored and renamed sources keep ID-bound preferences', async t => {
  const { registry } = await create(t);
  await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'Miruro']));
  await registry.setMode('miruro', 'off');
  let result = await registry.reconcile(snapshot(['reanime', 'RE'], ['ohli24', '애니24']));
  assert.deepEqual(result.changes.map(item => item.type).sort(), ['added', 'removed']);
  assert.equal(registry.data.providers.miruro.present, false);
  result = await registry.reconcile(snapshot(['reanime', 'RE:Anime'], ['miruro', 'Miruro']));
  assert.ok(result.changes.some(item => item.type === 'restored'));
  assert.ok(result.changes.some(item => item.type === 'renamed'));
  assert.equal(registry.mode('miruro'), 'off');
});

test('unreliable or incomplete update cannot delete all known sources', async t => {
  const { registry } = await create(t);
  await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'M']));
  const before = JSON.stringify(registry.data);
  assert.equal((await registry.reconcile({ reliable: false, providers: [] })).reliable, false);
  assert.equal(JSON.stringify(registry.data), before);
});

test('off mode stops scanning current source and cooldown expires automatically', async t => {
  const { registry, setNow } = await create(t);
  await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'M'], ['site3', 'Third']));
  await registry.setMode('reanime', 'off');
  assert.equal(registry.plan('reanime').disabledCurrent, true);
  for (let i = 0; i < 3; i++) await registry.reportScan([{ provider: 'site3', ok: false, error: 'anime mapping none' }]);
  assert.equal(registry.plan('miruro').providers.includes('site3'), true);
  assert.equal(registry.data.providers.site3.failures, 0);
  for (let i = 0; i < 3; i++) await registry.reportScan([{ provider: 'site3', ok: false, error: 'timeout' }]);
  assert.equal(registry.plan('miruro').providers.includes('site3'), false);
  assert.equal(registry.plan('miruro', { ignoreCooldown: true }).providers.includes('site3'), true);
  setNow(100000 + 31 * 60_000);
  assert.equal(registry.plan('miruro').providers.includes('site3'), true);
  await registry.reportScan([{ provider: 'site3', ok: true, value: { probe: {} } }]);
  assert.equal(registry.data.providers.site3.failures, 0);
});

test('user setting rollback and corruption protections work', async t => {
  const { registry } = await create(t);
  await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'M']));
  await registry.setMode('miruro', 'off');
  await registry.undo();
  assert.equal(registry.mode('miruro'), 'intensive');
  await assert.rejects(registry.setMode('missing', 'off'), /Unknown source/);
  await fs.writeFile(registry.file, '{broken');
  await assert.rejects(registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'M'])), /keeping it unchanged/);
  assert.equal(await fs.readFile(registry.file, 'utf8'), '{broken');
});

function source(provider, height, stability) {
  return { provider, ok: true, value: { provider, probe: {
    quality: { height, bandwidth: height * 1000 },
    metrics: { stability, failureRate: 0, minMbps: 10 }
  } } };
}
test('focus does not displace clearly higher-resolution source in deep scan', () => {
  const quick = { results: [source('better', 2160, 99), source('reanime', 1080, 99), source('miruro', 1080, 99), source('ohli24', 720, 99)] };
  const selected = chooseDeepSourceProviders(quick, { count: 2, intensiveProviders: ['reanime', 'miruro', 'ohli24'] });
  assert.equal(selected[0], 'better');
  assert.equal(selected.length, 2);
});

test('off current provider is not silently reinserted by the scout', async () => {
  const scan = await scanSources({}, { anime: { title: 'test' }, episode: { provider: 'blocked', number: 1 } },
    { providers: [], aliases: ['test'], includeCurrent: false });
  assert.equal(scan.results.length, 0);
  assert.equal(scan.decision.selected, null);
});

test('offline CLI can list sources without starting Lilac', async t => {
  const { registry } = await create(t);
  await registry.reconcile(snapshot(['reanime', 'RE'], ['miruro', 'M']));
  const env = { ...process.env, LOCALAPPDATA: path.dirname(registry.file) };
  // The default registry path is the only state source used by this command.
  const expectedPath = path.join(env.LOCALAPPDATA, 'LilacCompanion', 'source-registry.json');
  await fs.mkdir(path.dirname(expectedPath), { recursive: true });
  await fs.copyFile(registry.file, expectedPath);
  const run = spawnSync(process.execPath, ['src/main.mjs', 'sources', 'list'], {
    cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 10000
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /reanime/);
  assert.match(run.stdout, /miruro/);
});

test('source inventory discovery happens on connection, without a periodic timer', async () => {
  const entrypoint = await fs.readFile(path.resolve(import.meta.dirname, '../src/main.mjs'), 'utf8');
  assert.doesNotMatch(entrypoint, /LILAC_SOURCE_DISCOVERY_MS|sourceInventoryRefreshMs|lastSourceInventoryCheck/);
  assert.equal((entrypoint.match(/sourceRegistry\.refreshFromBridge\(/g) || []).length, 1);
  const connectAt = entrypoint.indexOf('connection = await connectBridge({ launch: !everConnected })');
  const discoverAt = entrypoint.indexOf('sourceRegistry.refreshFromBridge(connection.bridge)');
  const episodeAt = entrypoint.indexOf('const context = await connection.bridge.playbackContext()', connectAt);
  assert.ok(connectAt >= 0 && discoverAt > connectAt && episodeAt > discoverAt);
  assert.match(entrypoint, /registryWatcher = watchFs\(path\.dirname\(sourceRegistry\.file\)/);
  assert.doesNotMatch(entrypoint, /lastRegistryRead/);
});

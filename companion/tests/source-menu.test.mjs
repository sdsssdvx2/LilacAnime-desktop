import test from 'node:test';
import assert from 'node:assert/strict';
import { runSourceMenu } from '../src/source/source-menu.mjs';

async function drive(inputs, { providers = [], fail = null } = {}) {
  const queue = [...inputs], calls = [], output = [];
  await runSourceMenu({
    prompt: async () => queue.shift() ?? '0',
    log: value => output.push(String(value)),
    loadProviders: async () => providers,
    dispatch: async (action, id) => {
      calls.push([action, id || '']);
      if (action === fail) throw new Error('synthetic failure');
    }
  });
  return { calls, output: output.join('\n') };
}

test('menu requires no memorised commands and exposes all source modes', async () => {
  const providers = [
    { id: 'reanime', label: 'RE:Anime', mode: 'intensive', present: true },
    { id: 'newsource', label: 'New Source', mode: 'normal', present: true }
  ];
  const { calls, output } = await drive(['3', '2', '1', '3', '1', '2', '4', '0'], { providers });
  assert.deepEqual(calls, [
    ['list', ''],
    ['focus', 'newsource'],
    ['normal', 'reanime'],
    ['undo', '']
  ]);
  assert.match(output, /RE:Anime/);
  assert.match(output, /New Source/);
  assert.match(output, /소스별 진단 모드 변경/);
});

test('menu syncs only when requested and can run on-demand source doctor', async () => {
  const { calls } = await drive(['2', '5', '0']);
  assert.deepEqual(calls, [['list', ''], ['sync', ''], ['source-doctor', '']]);
});

test('invalid selection and cancelled mode do not mutate policy', async () => {
  const providers = [{ id: 'miruro', label: 'Miruro', mode: 'intensive', present: true }];
  const { calls, output } = await drive(['3', '9', '3', '1', '0', '0'], { providers });
  assert.deepEqual(calls, [['list', '']]);
  assert.match(output, /설정을 변경하지 않았습니다/);
});

test('failed CLI operation stays within menu and does not disrupt watch process', async () => {
  const { calls, output } = await drive(['2', '1', '0'], { fail: 'sync' });
  assert.deepEqual(calls, [['list', ''], ['sync', ''], ['list', '']]);
  assert.match(output, /synthetic failure/);
});

test('no known sources explains how to synchronize', async () => {
  const { calls, output } = await drive(['3', '0']);
  assert.deepEqual(calls, [['list', '']]);
  assert.match(output, /동기화/);
});

test('anime menu uses recent target and numbered provider selection, not memorized IDs', async () => {
  const input = ['6', '1', '1', '1', '3', '2', '0', '0'];
  const commands = [], logs = [];
  await runSourceMenu({
    prompt: async () => input.shift() ?? '0',
    log: value => logs.push(String(value)),
    loadProviders: async () => [
      { id: 'miruro', label: 'Miruro', mode: 'intensive', present: true },
      { id: 'reanime', label: 'RE:Anime', mode: 'intensive', present: true }
    ],
    dispatch: async action => commands.push(['source', action]),
    loadAnimeTargets: async () => [{
      anime: { title: 'Example', anilistId: 19 }, episode: { number: 8 }
    }],
    loadAnimeRules: async () => [],
    showAnimePolicy: async () => null,
    changeAnimePolicy: async (ctx, scope, operation, provider) =>
      commands.push(['anime', ctx.anime.anilistId, scope, operation, provider]),
    deleteAnimePolicy: async () => assert.fail('Must not delete')
  });
  assert.deepEqual(commands, [
    ['source', 'list'], ['anime', 19, 'series', 'exclude', 'reanime']
  ]);
  assert.match(logs.join('\n'), /작품별 소스 설정/);
});

test('anime rule list may be viewed and deleted only after explicit confirmation', async () => {
  const input = ['6', '2', '1', '1', '0', '0'];
  const deleted = [];
  await runSourceMenu({
    prompt: async () => input.shift() ?? '0', log: () => {},
    dispatch: async () => {}, loadProviders: async () => [],
    loadAnimeTargets: async () => [],
    loadAnimeRules: async () => [{
      key: 'anilist:19', title: 'Example',
      series: { preferred: 'miruro', excluded: [], locked: false }, episodes: {}
    }],
    changeAnimePolicy: async () => assert.fail('No change needed'),
    deleteAnimePolicy: async key => deleted.push(key)
  });
  assert.deepEqual(deleted, ['anilist:19']);
});

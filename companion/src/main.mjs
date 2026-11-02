import fs from 'node:fs/promises';
import path from 'node:path';
import { connectLilacCdp } from './lilac/cdp.mjs';
import { LilacBridge } from './lilac/bridge.mjs';
import { launchLilacForCompanion } from './lilac/launcher.mjs';
import { indexSubtitleRoot } from './subtitles/indexer.mjs';
import { chooseSubtitleMatch } from './subtitles/matcher.mjs';
import { prepareSubtitle } from './subtitles/prepare.mjs';
import { scanSources, deepScanTop } from './source/scout.mjs';
import { StateStore } from './state.mjs';

const VERSION = '0.1.0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = process.argv[2] || 'watch';
const subtitleRoot = process.env.LILAC_SUBTITLE_ROOT || 'D:\\Utility\\자막';
const cdpPort = Number(process.env.LILAC_CDP_PORT || 9223);

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readyConnection() {
  const { session, target } = await connectLilacCdp({ port: cdpPort });
  const bridge = new LilacBridge(session);
  try {
    await bridge.waitUntilReady();
    return { session, bridge, target };
  } catch (error) {
    session.close();
    throw error;
  }
}

async function connectBridge({ launch = true } = {}) {
  try {
    return await readyConnection();
  } catch (first) {
    if (!launch) throw first;
    await launchLilacForCompanion(cdpPort);
    let last = first;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { return await readyConnection(); }
      catch (error) { last = error; }
    }
    throw last;
  }
}

function playbackRef(store, context) {
  const anime = store.animeKey(context.anime);
  const ep = context.episode?.number || context.episode?.id || context.episode?.url || '';
  return `${anime}|${ep}|${context.episode?.provider || ''}|${context.stream?.server || ''}`;
}

async function collectVariants(bridge, anime) {
  const seeds = [...new Set([
    anime.title,
    anime.title_english,
    anime.romaji,
    anime.title_japanese
  ].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 3);
  const output = new Set();
  for (const seed of seeds) {
    try { for (const value of await bridge.titleVariants(seed)) output.add(value); }
    catch {}
  }
  return [...output];
}

async function doctor() {
  const index = await indexSubtitleRoot(subtitleRoot);
  console.log(`[companion] subtitle root: ${subtitleRoot}`);
  console.log(`[companion] subtitle files: ${index.files.length}`);
  const { session, bridge, target } = await connectBridge({ launch: false });
  try {
    console.log(`[companion] CDP target: ${target.title || target.url}`);
    console.log('[companion] features:', await bridge.features());
    const context = await bridge.playbackContext();
    console.log('[companion] playback:', context);
    if (context?.anime && context?.episode?.number) {
      const aliases = await collectVariants(bridge, context.anime);
      console.log('[companion] title variants:', aliases);
      const match = chooseSubtitleMatch({ anime: context.anime, episode: context.episode.number, aliases, files: index.files });
      console.log('[companion] best local subtitle:', match.best ? { confidence: match.confidence, score: match.best.score, path: match.best.file.path, reasons: match.best.reasons } : null);
    }
  } finally { session.close(); }
}

function printSourceScan(name, scan) {
  console.log(`\n[companion] ${name}`);
  for (const item of scan.results) {
    if (!item.ok) { console.log(`  ${item.provider}: FAIL · ${item.error}`); continue; }
    const probe = item.value.probe;
    if (!probe) { console.log(`  ${item.provider}: ${item.value.kind} · ${item.value.note || 'resolved'}`); continue; }
    const q = probe.quality, m = probe.metrics;
    console.log(`  ${item.provider}: ${q.height ? `${q.height}p` : '?p'} · ${(q.bandwidth || 0) ? `${((q.averageBandwidth || q.bandwidth) / 1_000_000).toFixed(2)} Mbps` : '? Mbps'} · stability ${m.stability} · min ${m.minMbps == null ? '?' : m.minMbps.toFixed(2)} Mbps · TTFB95 ${m.p95TtfbMs == null ? '?' : Math.round(m.p95TtfbMs)} ms`);
  }
  const selected = scan.decision?.selected;
  console.log(`[companion] recommendation: ${selected?.provider || 'none'} (${scan.decision?.reason || 'n/a'})`);
}

async function sourceDoctor() {
  const { session, bridge, target } = await connectBridge({ launch: false });
  try {
    console.log(`[companion] CDP target: ${target.title || target.url}`);
    const context = await bridge.playbackContext();
    if (!context?.anime || !context?.episode?.number) throw new Error('Play an anime episode in Lilac before source-doctor');
    console.log(`[companion] source doctor: ${context.anime.title || context.anime.title_english} · E${context.episode.number}`);
    const quick = await scanSources(bridge, context, { sampleCount: 1 });
    printSourceScan('quick scan (all providers)', quick);
    const deep = await deepScanTop(bridge, quick, { count: 3, sampleCount: 3 });
    printSourceScan('deep scan (top providers)', deep);
  } finally { session.close(); }
}

async function watch() {
  const state = await new StateStore().load();
  let index = await indexSubtitleRoot(subtitleRoot);
  let indexedAt = Date.now();
  let connection = null;
  let handledRef = '';
  let lastAttachedPath = '';
  console.log(`[companion] indexed ${index.files.length} subtitle files from ${subtitleRoot}`);

  for (;;) {
    try {
      if (!connection) {
        connection = await connectBridge({ launch: true });
        const features = await connection.bridge.features();
        console.log(`[companion] connected: ${connection.target.title || connection.target.url}`);
        console.log(`[companion] features: ${JSON.stringify(features)}`);
        handledRef = '';
      }

      if (Date.now() - indexedAt > 60000) {
        index = await indexSubtitleRoot(subtitleRoot);
        indexedAt = Date.now();
      }

      const context = await connection.bridge.playbackContext();
      if (!context?.anime || !context?.episode?.number) { await sleep(900); continue; }
      const ref = playbackRef(state, context);

      // A user subtitle already chosen inside Lilac always wins. Remember it when it is a real local file.
      if (context.subtitle?.source === 'user' && context.subtitle.path && context.subtitle.path !== lastAttachedPath && await exists(context.subtitle.path)) {
        await state.rememberSubtitle(context.anime, context.episode.number, { path: context.subtitle.path, kind: 'user' });
        handledRef = ref;
        console.log(`[companion] remembered user subtitle: ${context.subtitle.path}`);
        await sleep(900);
        continue;
      }

      if (ref === handledRef) { await sleep(900); continue; }
      // Let Lilac finish its own episode transition first; then local subtitles may override online/provider subtitles.
      await sleep(650);
      const stable = await connection.bridge.playbackContext();
      if (!stable?.anime || playbackRef(state, stable) !== ref) continue;

      const aliases = await collectVariants(connection.bridge, stable.anime);
      const preference = state.subtitlePreference(stable.anime, stable.episode.number);
      const manual = preference?.kind === 'user' ? preference : null;
      const match = chooseSubtitleMatch({
        anime: stable.anime,
        episode: stable.episode.number,
        aliases,
        files: index.files,
        manual
      });

      handledRef = ref;
      await state.touchRecent(stable.anime, stable.episode.number);
      if (!match.selected) {
        if (match.best) console.log(`[companion] local subtitle not auto-applied (${match.confidence}, score ${match.best.score}): ${match.best.file.path}`);
        else console.log('[companion] no local subtitle candidate; Lilac keeps its normal subtitle flow');
        continue;
      }

      if (stable.subtitle?.source === 'user' && path.resolve(stable.subtitle.path || '') === path.resolve(match.selected.path)) continue;
      const prepared = await prepareSubtitle(match.selected.path);
      await connection.bridge.attachPreparedSubtitle(prepared, { label: `Lilac Companion · ${path.basename(match.selected.path)}` });
      lastAttachedPath = match.selected.path;
      console.log(`[companion] auto-applied local subtitle (${match.confidence}): ${match.selected.path}`);
    } catch (error) {
      console.error(`[companion] ${error?.message || error}`);
      try { connection?.session?.close(); } catch {}
      connection = null;
      await sleep(1500);
    }
  }
}

if (command === 'version' || command === '--version' || command === '-v') console.log(`Lilac Companion ${VERSION}`);
else if (command === 'doctor') await doctor();
else if (command === 'source-doctor') await sourceDoctor();
else if (command === 'watch') await watch();
else throw new Error(`Unknown command: ${command}`);

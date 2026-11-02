import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import { connectLilacCdp } from './lilac/cdp.mjs';
import { LilacBridge } from './lilac/bridge.mjs';
import { launchLilacForCompanion } from './lilac/launcher.mjs';
import { normalizeTitle } from './normalize.mjs';
import { indexSubtitleRoot } from './subtitles/indexer.mjs';
import { chooseSubtitleMatch } from './subtitles/matcher.mjs';
import { reverseResolveLocalAliases, localAliasCandidates } from './subtitles/alias-fallback.mjs';
import { prepareSubtitle } from './subtitles/prepare.mjs';
import { scanSources, deepScanTop, safeAutoSwitchDecision } from './source/scout.mjs';
import { StateStore } from './state.mjs';

const VERSION = '0.1.0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = process.argv[2] || 'watch';
const subtitleRoot = process.env.LILAC_SUBTITLE_ROOT || 'D:\\Utility\\자막';
const cdpPort = Number(process.env.LILAC_CDP_PORT || 9223);
const sourceAutoMode = String(process.env.LILAC_SOURCE_AUTO || 'safe').toLowerCase();
const sourceCacheMs = Number(process.env.LILAC_SOURCE_CACHE_MS || 6 * 60 * 60 * 1000);
const sourceAutoSwitchMaxSeconds = Number(process.env.LILAC_SOURCE_SWITCH_MAX_SECONDS || 25);

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
  if (launch) console.log(`[companion] checking for Companion-enabled Lilac on CDP ${cdpPort}...`);
  try {
    return await readyConnection();
  } catch (first) {
    if (!launch) throw first;
    console.log(`[companion] no ready Lilac on CDP ${cdpPort}; locating LilacAnime.exe...`);
    const resolved = await launchLilacForCompanion(cdpPort);
    console.log(`[companion] launching Lilac (${resolved.source}): ${resolved.path}`);
    console.log('[companion] waiting for Lilac renderer to become ready...');
    let last = first;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try { return await readyConnection(); }
      catch (error) { last = error; }
      if ((i + 1) % 10 === 0) console.log(`[companion] still waiting for Lilac... ${Math.round((i + 1) / 2)}s`);
    }
    throw last;
  }
}

function playbackRef(store, context) {
  const anime = store.animeKey(context.anime);
  const ep = context.episode?.number || context.episode?.id || context.episode?.url || '';
  const entry = Number(context.playbackSessionId || 0) || 0;
  return `${anime}|${ep}|${context.episode?.provider || ''}|${context.stream?.server || ''}|entry:${entry}`;
}

function sourceEpisodeKey(context) {
  const anime = context?.anime || {};
  const identity = anime.anilistId || anime.malId || anime.mal_id || normalizeTitle(anime.title_english || anime.romaji || anime.title || '');
  const episode = Number(context?.episode?.number || 0) || context?.episode?.id || '';
  return identity && episode ? `${identity}|${episode}` : '';
}

async function collectVariants(bridge, anime) {
  const synonyms = Array.isArray(anime.synonyms) ? anime.synonyms : String(anime.synonyms || '').split(/[,|]/);
  const seeds = [...new Set([
    anime.title,
    anime.title_english,
    anime.romaji,
    anime.title_japanese,
    ...synonyms
  ].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 8);
  const output = new Set(seeds);
  const [variantGroups, resolved] = await Promise.all([
    Promise.all(seeds.slice(0, 4).map(async seed => {
      try { return await bridge.titleVariants(seed); } catch { return []; }
    })),
    bridge.resolveTitles([anime]).catch(() => [])
  ]);
  for (const group of variantGroups) for (const value of (Array.isArray(group) ? group : [])) output.add(value);
  for (const item of (Array.isArray(resolved) ? resolved : [])) {
    if (item?.ko) output.add(item.ko);
    if (item?.en) output.add(item.en);
  }
  return [...output];
}

async function chooseLocalSubtitleWithFallback(bridge, { anime, episode, episodeMeta, aliases, files, manual }) {
  let effectiveAliases = aliases;
  const candidates = localAliasCandidates({ anime, episode, episodeMeta, files }).map(item => item.query);
  let match = chooseSubtitleMatch({ anime, episode, episodeMeta, aliases: effectiveAliases, files, manual });
  if (match.selected || manual) return { match, aliases: effectiveAliases, fallback: [], candidates };

  const fallback = await reverseResolveLocalAliases(bridge, {
    anime,
    episode,
    episodeMeta,
    aliases: effectiveAliases,
    files
  }).catch(() => []);
  if (!fallback.length) return { match, aliases: effectiveAliases, fallback: [], candidates };
  effectiveAliases = [...new Set([...effectiveAliases, ...fallback])];
  match = chooseSubtitleMatch({ anime, episode, episodeMeta, aliases: effectiveAliases, files, manual });
  return { match, aliases: effectiveAliases, fallback, candidates };
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
      const resolved = await chooseLocalSubtitleWithFallback(bridge, {
        anime: context.anime,
        episode: context.episode.number,
        episodeMeta: context.episode,
        aliases,
        files: index.files,
        manual: null
      });
      if (resolved.candidates.length) console.log('[companion] local alias candidates:', resolved.candidates);
      if (resolved.fallback.length) console.log('[companion] reverse-resolved local aliases:', resolved.fallback);
      const match = resolved.match;
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
    const extra = item.value.note ? ` · ${item.value.note}` : '';
    console.log(`  ${item.provider}: ${q.height ? `${q.height}p` : '?p'} · ${(q.bandwidth || q.averageBandwidth || 0) ? `${((q.averageBandwidth || q.bandwidth) / 1_000_000).toFixed(2)} Mbps` : '? Mbps'} · stability ${m.stability} · min ${m.minMbps == null ? '?' : m.minMbps.toFixed(2)} Mbps · TTFB95 ${m.p95TtfbMs == null ? '?' : Math.round(m.p95TtfbMs)} ms${extra}`);
  }
  if (scan.visual) console.log(`[companion] visual compare: ${scan.visual.selectedProvider || 'none'} · ${scan.visual.confidence || 'none'} · ${scan.visual.reason || 'n/a'}`);
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

function startSubtitleWatcher(onDirty) {
  try {
    const watcher = watchFs(subtitleRoot, { recursive: true }, (_eventType, filename) => onDirty(filename));
    watcher.on('error', error => console.warn(`[companion] subtitle watcher error; periodic rescan remains active: ${error?.message || error}`));
    console.log(`[companion] watching subtitle folder for changes: ${subtitleRoot}`);
    return watcher;
  } catch (error) {
    console.warn(`[companion] live subtitle watching unavailable; using periodic rescan: ${error?.message || error}`);
    return null;
  }
}

async function watch() {
  const state = await new StateStore().load();
  let index = await indexSubtitleRoot(subtitleRoot);
  let indexedAt = Date.now();
  let subtitlesDirty = false;
  let subtitleChangedAt = 0;
  let connection = null;
  let handledRef = '';
  let lastAttachedPath = '';
  const sourceTasks = new Map();
  const sourceDone = new Map();
  let sourceSwitchGuard = { episode: null, until: 0 };
  console.log(`[companion] indexed ${index.files.length} subtitle files from ${subtitleRoot}`);
  console.log(`[companion] source auto mode: ${sourceAutoMode}`);

  startSubtitleWatcher(() => {
    subtitlesDirty = true;
    subtitleChangedAt = Date.now();
  });

  const startSourceDiagnosis = context => {
    if (sourceAutoMode === 'off' || !context?.anime || !context?.episode?.number) return;
    if (sourceSwitchGuard.until > Date.now() && sourceSwitchGuard.episode === Number(context.episode.number)) return;
    const key = sourceEpisodeKey(context);
    if (!key || sourceTasks.has(key)) return;
    const doneAt = Number(sourceDone.get(key) || 0);
    if (doneAt && Date.now() - doneAt < sourceCacheMs) return;

    const task = (async () => {
      let diagnosisConnection = null;
      try {
        await sleep(1200);
        diagnosisConnection = await connectBridge({ launch: false });
        const start = await diagnosisConnection.bridge.playbackContext();
        if (!start?.anime || sourceEpisodeKey(start) !== key) return;
        console.log(`[companion] source scan started: ${start.anime.title || start.anime.title_english} · E${start.episode.number} (current ${start.episode.provider})`);
        const quick = await scanSources(diagnosisConnection.bridge, start, { sampleCount: 1, concurrency: 2 });
        const afterQuick = await diagnosisConnection.bridge.playbackContext().catch(() => null);
        if (!afterQuick?.anime || sourceEpisodeKey(afterQuick) !== key) {
          console.log('[companion] source scan cancelled: playback changed during quick scan');
          return;
        }
        printSourceScan('auto quick scan (all providers)', quick);
        const deep = await deepScanTop(diagnosisConnection.bridge, quick, { count: 3, sampleCount: 3 });
        const afterDeep = await diagnosisConnection.bridge.playbackContext().catch(() => null);
        if (!afterDeep?.anime || sourceEpisodeKey(afterDeep) !== key) {
          console.log('[companion] source scan cancelled: playback changed during deep scan');
          return;
        }
        printSourceScan('auto deep scan (top providers)', deep);
        const selected = deep.decision?.selected;
        const safety = safeAutoSwitchDecision(deep, start.episode.provider);
        const cacheTime = selected ? Date.now() : Date.now() - sourceCacheMs + 5 * 60 * 1000;
        sourceDone.set(key, cacheTime);
        console.log(`[companion] source recommendation: ${selected?.provider || 'none'} · ${safety.reason}`);

        const live = afterDeep;
        if (live.episode?.provider !== start.episode?.provider) {
          console.log(`[companion] source switch skipped: provider changed during scan (${start.episode.provider} -> ${live.episode.provider}); treating it as a user override`);
          return;
        }
        if (!safety.switch) return;
        if (Number(live.currentTime || 0) > sourceAutoSwitchMaxSeconds) {
          console.log(`[companion] source switch skipped: already ${Math.round(live.currentTime)}s into playback`);
          return;
        }
        if (sourceAutoMode !== 'safe' && sourceAutoMode !== 'on') return;

        console.log(`[companion] auto-switching source: ${live.episode.provider} -> ${safety.selected.provider} (${safety.reason})`);
        sourceSwitchGuard = { episode: Number(live.episode.number), until: Date.now() + 60000 };
        await diagnosisConnection.bridge.switchToResolvedSource(safety.selected, {
          title: live.anime.title || live.anime.title_english || live.anime.romaji || ''
        });
        handledRef = '';
        lastAttachedPath = '';
      } finally {
        try { diagnosisConnection?.session?.close(); } catch {}
      }
    })().catch(error => {
      console.warn(`[companion] source scan failed: ${error?.message || error}`);
      sourceDone.set(key, Date.now() - sourceCacheMs + 5 * 60 * 1000);
    }).finally(() => sourceTasks.delete(key));

    sourceTasks.set(key, task);
  };

  for (;;) {
    try {
      if (!connection) {
        connection = await connectBridge({ launch: true });
        const features = await connection.bridge.features();
        console.log(`[companion] connected: ${connection.target.title || connection.target.url}`);
        console.log(`[companion] features: ${JSON.stringify(features)}`);
        handledRef = '';
      }

      const shouldRefreshForChange = subtitlesDirty && Date.now() - subtitleChangedAt >= 500;
      const shouldSafetyRefresh = Date.now() - indexedAt > 60000;
      if (shouldRefreshForChange || shouldSafetyRefresh) {
        const before = index.files.length;
        index = await indexSubtitleRoot(subtitleRoot);
        indexedAt = Date.now();
        if (shouldRefreshForChange || index.files.length !== before) {
          console.log(`[companion] subtitle index refreshed: ${before} -> ${index.files.length} files`);
          handledRef = '';
        }
        subtitlesDirty = false;
      }

      const context = await connection.bridge.playbackContext();
      if (!context?.anime || !context?.episode?.number) {
        if (!context?.activePlayer) {
          handledRef = '';
          lastAttachedPath = '';
        }
        await sleep(900);
        continue;
      }
      const ref = playbackRef(state, context);

      if (context.subtitle?.source === 'user' && context.subtitle.path && context.subtitle.path !== lastAttachedPath && await exists(context.subtitle.path)) {
        await state.rememberSubtitle(context.anime, context.episode.number, { path: context.subtitle.path, kind: 'user' });
        handledRef = ref;
        console.log(`[companion] remembered user subtitle: ${context.subtitle.path}`);
        startSourceDiagnosis(context);
        await sleep(900);
        continue;
      }

      if (ref === handledRef) {
        startSourceDiagnosis(context);
        await sleep(900);
        continue;
      }
      console.log(`[companion] playback detected: ${context.anime.title || context.anime.title_english || context.anime.romaji || 'unknown'} · E${context.episode.number} · entry ${context.playbackSessionId || 0}`);
      await sleep(650);
      const stable = await connection.bridge.playbackContext();
      if (!stable?.anime || playbackRef(state, stable) !== ref) continue;

      const preference = state.subtitlePreference(stable.anime, stable.episode.number);
      const manual = preference?.kind === 'user' ? preference : null;
      const resolved = await chooseLocalSubtitleWithFallback(connection.bridge, {
        anime: stable.anime,
        episode: stable.episode.number,
        episodeMeta: stable.episode,
        aliases: [],
        files: index.files,
        manual
      });
      const match = resolved.match;
      if (resolved.fallback.length) {
        console.log(`[companion] local title alias resolved: ${resolved.fallback.slice(0, 8).join(' | ')}`);
      }

      handledRef = ref;
      await state.touchRecent(stable.anime, stable.episode.number);
      if (!match.selected) {
        if (resolved.candidates.length) console.log(`[companion] local alias candidates tried: ${resolved.candidates.slice(0, 10).join(' | ')}`);
        if (match.best) console.log(`[companion] local subtitle not auto-applied (${match.confidence}, score ${match.best.score}): ${match.best.file.path}`);
        else console.log('[companion] no local subtitle candidate; Lilac keeps its normal subtitle flow');
        startSourceDiagnosis(stable);
        continue;
      }

      if (stable.subtitle?.source === 'user' && path.resolve(stable.subtitle.path || '') === path.resolve(match.selected.path)) {
        startSourceDiagnosis(stable);
        continue;
      }
      const prepared = await prepareSubtitle(match.selected.path);
      await connection.bridge.attachPreparedSubtitle(prepared, { label: `Lilac Companion · ${path.basename(match.selected.path)}` });
      lastAttachedPath = match.selected.path;
      console.log(`[companion] auto-applied local subtitle (${match.confidence}): ${match.selected.path}`);
      startSourceDiagnosis(stable);
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

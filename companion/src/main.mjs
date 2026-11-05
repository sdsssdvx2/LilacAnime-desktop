import fs from 'node:fs/promises';
import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import { connectLilacCdp } from './lilac/cdp.mjs';
import { LilacBridge } from './lilac/bridge.mjs';
import { launchLilacForCompanion, runningLilacExecutable } from './lilac/launcher.mjs';
import { lilacRecoveryAction } from './lilac/lifecycle.mjs';
import { normalizeTitle } from './normalize.mjs';
import { indexSubtitleRoot } from './subtitles/indexer.mjs';
import { chooseSubtitleMatch } from './subtitles/matcher.mjs';
import { reverseResolveLocalAliases, localAliasCandidates } from './subtitles/alias-fallback.mjs';
import { prepareSubtitle } from './subtitles/prepare.mjs';
import { isUserSubtitleCompatibleWithEpisode } from './subtitles/user-selection.mjs';
import { scanSources, deepScanTop, safeAutoSwitchDecision } from './source/scout.mjs';
import { SourceDecisionCache } from './source/decision-cache.mjs';
import { SourceRegistry } from './source/source-registry.mjs';
import { AnimeSourcePolicies, RecentAnimeSources, managedSourcePlan, choosePolicySource, policySwitchDecision, animeSourceIdentity } from './source/anime-source-policies.mjs';
import { listenForSourceManager } from './source/source-menu-hotkey.mjs';
import { sourcePlaybackSessionKey } from './source/playback-session.mjs';
import { chooseBestSource, rankSourceResults } from './source/scout.mjs';
import { runSourceMenu } from './source/source-menu.mjs';
import { allowQuickAutoSwitch } from './source/quick-switch.mjs';
import { withinSourceSwitchWindow } from './source/switch-window.mjs';
import { StateStore } from './state.mjs';

const VERSION = '1.1.0';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = process.argv[2] || 'watch';
const subtitleRoot = process.env.LILAC_SUBTITLE_ROOT || 'D:\\Utility\\자막';
const cdpPort = Number(process.env.LILAC_CDP_PORT || 9223);
const sourceAutoMode = String(process.env.LILAC_SOURCE_AUTO || 'safe').toLowerCase();
const sourceDecisionCacheMs = Number(process.env.LILAC_SOURCE_DECISION_CACHE_MS || process.env.LILAC_SOURCE_CACHE_MS || 15 * 60 * 1000);
const sourceQuickDecisionCacheMs = Number(process.env.LILAC_SOURCE_QUICK_CACHE_MS || 2 * 60 * 1000);
const sourceRetryMs = Number(process.env.LILAC_SOURCE_RETRY_MS || 5 * 60 * 1000);
const sourceAutoSwitchMaxSeconds = Number(process.env.LILAC_SOURCE_SWITCH_MAX_SECONDS || 120);
const subtitleSafetyScanMs = Math.max(60_000, Number(process.env.LILAC_SUBTITLE_SAFETY_SCAN_MS || 10 * 60 * 1000));

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
  const externalIdentity = anime.anilistId || anime.malId || (/^\d+$/.test(String(anime.mal_id || '')) ? anime.mal_id : '');
  const titleIdentity = normalizeTitle(anime.title_english || anime.romaji || anime.title || '');
  const identity = externalIdentity || (titleIdentity ? `${titleIdentity}|season:${String(anime.season || '')}|year:${String(anime.year || '')}` : '');
  const episode = Number(context?.episode?.number || 0) || context?.episode?.id || '';
  return identity && episode ? `${identity}|${episode}` : '';
}

function activeSourceSession(context) {
  return sourcePlaybackSessionKey(sourceEpisodeKey(context), context);
}
function withAnimePolicy(scan, policy) {
  return choosePolicySource(scan, policy, { chooseBestSource, rankSourceResults });
}
function decideWithAnimePolicy(scan, currentProvider, policy) {
  return policySwitchDecision(scan, currentProvider, policy, safeAutoSwitchDecision);
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

function printSourceChanges(result) {
  if (!result?.reliable) {
    console.warn(`[companion] source inventory unchanged: ${result?.reason || 'source UI unavailable'}`);
    return;
  }
  if (result.initial) console.log(`[companion] source inventory initialised from Lilac: ${result.count} sources`);
  for (const change of result.changes) {
    console.log(`[companion] source ${change.type}: ${change.id} (${change.from ? change.from + ' -> ' : ''}${change.label})`);
  }
}

function printSourceInventory(registry) {
  const records = Object.entries(registry.data.providers).sort(([a], [b]) => a.localeCompare(b));
  console.log(`[companion] source registry: ${registry.file}`);
  console.log(`[companion] inventory: ${registry.data.initialised ? 'last verified ' + new Date(registry.data.checkedAt).toLocaleString() : 'not yet synced'}`);
  if (!records.length) console.log('  No sources recorded. Start Lilac with Companion, or run: sources sync');
  for (const [id, item] of records) {
    const presence = item.present ? 'available in Lilac' : 'not in Lilac';
    const cooldown = item.retryAfter > Date.now() ? ' · cooldown until ' + new Date(item.retryAfter).toLocaleString() : '';
    console.log(`  ${id.padEnd(13)} ${String(item.label).padEnd(14)} · ${presence} · ${registry.mode(id)} · diagnosis ${item.lastDiagnosis}${cooldown}`);
  }
}

async function sourcesCommand(action = 'list', id = '') {
  const registry = await new SourceRegistry().load();
  if (action === 'sync') {
    const { session, bridge } = await connectBridge({ launch: false });
    try { printSourceChanges(await registry.refreshFromBridge(bridge)); }
    finally { session.close(); }
  } else if (['focus', 'intensive', 'normal', 'off'].includes(action)) {
    if (!id) throw new Error('Usage: sources focus|normal|off SOURCE_ID');
    await registry.setMode(id.toLowerCase(), action === 'focus' ? 'intensive' : action);
    console.log(`[companion] saved source mode for ${id}`);
  } else if (action === 'reset') {
    if (!id) throw new Error('Usage: sources reset SOURCE_ID');
    await registry.resetMode(id.toLowerCase());
    console.log(`[companion] restored default mode for ${id}`);
  } else if (action === 'undo') {
    await registry.undo();
    console.log('[companion] previous manual source setting restored');
  } else if (action !== 'list') {
    throw new Error('Usage: sources [list|sync|focus ID|normal ID|off ID|reset ID|undo]');
  }
  printSourceInventory(registry);
}

async function sourceMenu() {
  await runSourceMenu({
    dispatch: (action, id = '') => action === 'source-doctor' ? sourceDoctor() : sourcesCommand(action, id),
    loadProviders: async () => {
      const registry = await new SourceRegistry().load();
      return Object.entries(registry.data.providers)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([id, item]) => ({ id, label: item.label, present: item.present, mode: registry.mode(id) }));
    },
    loadAnimeTargets: async () => {
      const recent = await new RecentAnimeSources().list();
      let current = null;
      try {
        const { session, bridge } = await connectBridge({ launch: false });
        try {
          const context = await bridge.playbackContext();
          if (activeSourceSession(context)) current = context;
        } finally { session.close(); }
      } catch { /* The recent list works without a running Lilac. */ }
      const targets = current ? [current] : [];
      const seen = new Set(targets.map(animeSourceIdentity));
      for (const item of recent) {
        const identity = animeSourceIdentity(item);
        if (!seen.has(identity)) { targets.push(item); seen.add(identity); }
      }
      return targets;
    },
    loadAnimeRules: async () => (await new AnimeSourcePolicies().load()).list(),
    showAnimePolicy: async context => (await new AnimeSourcePolicies().load()).resolve(context),
    changeAnimePolicy: async (context, scope, action, provider) =>
      (await new AnimeSourcePolicies().load()).set(context, scope, action, provider),
    deleteAnimePolicy: async key => (await new AnimeSourcePolicies().load()).clearKey(key)
  });
}

function printHelp() {
  console.log('Lilac Companion ' + VERSION);
  console.log('  LilacCompanion.exe              Start automatic watch mode');
  console.log('  LilacCompanion.exe sources menu Guided source management (recommended)');
  console.log('  LilacCompanion.exe sources list Show saved sources and settings');
  console.log('  LilacCompanion.exe sources sync Compare current Lilac source list');
  console.log('  LilacCompanion.exe sources focus|normal|off|reset SOURCE_ID');
  console.log('  LilacCompanion.exe sources undo Restore previous setting change');
  console.log('  LilacCompanion.exe source-doctor Diagnose currently playing episode');
  console.log('  During watch: enter 1 + Enter to open Source Manager window');
  console.log('  In Source Manager: option 6 sets per-anime/per-episode rules');
  console.log('  LilacCompanion.exe help         Show this help');
}

async function sourceDoctor() {
  const registry = await new SourceRegistry().load();
  const { session, bridge, target } = await connectBridge({ launch: false });
  try {
    console.log(`[companion] CDP target: ${target.title || target.url}`);
    const inventory = await registry.refreshFromBridge(bridge);
    printSourceChanges(inventory);
    printSourceInventory(registry);
    if (!inventory.reliable) {
      console.log('[companion] source diagnosis skipped: no reliable live provider inventory');
      return;
    }
    const context = await bridge.playbackContext();
    if (!context?.anime || !context?.episode?.number) {
      console.log('[companion] To diagnose video quality, open an episode in Lilac first.');
      return;
    }
    const policy = (await new AnimeSourcePolicies().load()).resolve(context);
    const plan = managedSourcePlan(registry.plan(context.episode.provider, { ignoreCooldown: true }), policy);
    if (plan.disabledCurrent || !plan.providers.length) {
      console.log('[companion] current source excluded globally or no managed sources enabled');
      return;
    }
    console.log(`[companion] source doctor: ${context.anime.title || context.anime.title_english} · E${context.episode.number}`);
    const quickRaw = await scanSources(bridge, context, { sampleCount: 1, providers: plan.providers, includeCurrent: false });
    const quick = withAnimePolicy(quickRaw, policy);
    printSourceScan('quick scan (managed sources)', quick);
    await registry.reportScan(quickRaw.results);
    const deepCandidates = policy ? { ...quick, results: quick.results.filter(row => !policy.excluded.includes(row.provider)) } : quick;
    const deepRaw = await deepScanTop(bridge, deepCandidates, { count: 3, sampleCount: 3, intensiveProviders: plan.intensive, includeCurrent: false });
    const deep = withAnimePolicy(deepRaw, policy);
    printSourceScan('deep scan (top managed providers)', deep);
  } finally { session.close(); }
}

function startSubtitleWatcher(onDirty) {
  try {
    const watcher = watchFs(subtitleRoot, { recursive: true }, (_eventType, filename) => onDirty(filename));
    watcher.unref?.();
    watcher.on('error', error => console.warn(`[companion] subtitle watcher error; periodic rescan remains active: ${error?.message || error}`));
    console.log(`[companion] watching subtitle folder for changes: ${subtitleRoot}`);
    return watcher;
  } catch (error) {
    console.warn(`[companion] live subtitle watching unavailable; using periodic rescan: ${error?.message || error}`);
    return null;
  }
}

async function watch() {
  console.log(`[companion] version: ${VERSION}`);
  const stopMenuShortcut = listenForSourceManager();
  const state = await new StateStore().load();
  const sourceRegistry = await new SourceRegistry().load();
  const animePolicies = await new AnimeSourcePolicies().load();
  const recentlyPlayed = new RecentAnimeSources();
  let index = await indexSubtitleRoot(subtitleRoot);
  let indexedAt = Date.now();
  let subtitlesDirty = false;
  let subtitleChangedAt = 0;
  let connection = null;
  let everConnected = false;
  let handledRef = '';
  let lastAttachedPath = '';
  let lastObservedUserSubtitleKey = '';
  const sourceTasks = new Map();
  const sourceDecisions = new SourceDecisionCache({ ttlMs: sourceDecisionCacheMs, retryMs: sourceRetryMs });
  let sourceSwitchGuard = { episodeKey: '', provider: '', session: '', until: 0 };
  let liveInventoryTrusted = false;
  let registryDirty = false;
  let policiesDirty = false;
  let lastRegistrySignature = sourceRegistry.plan().signature;
  let lastPolicySignature = animePolicies.signature();
  console.log(`[companion] indexed ${index.files.length} subtitle files from ${subtitleRoot}`);
  console.log(`[companion] source auto mode: ${sourceAutoMode}`);
  console.log('[companion] focus defaults: RE:Anime / Miruro / 애니24; other active sources are checked lightly');

  const subtitleWatcher = startSubtitleWatcher(() => {
    subtitlesDirty = true;
    subtitleChangedAt = Date.now();
  });

  // Source settings are changed by a separate CLI process. Watch local file
  // changes instead of repeatedly reading it or polling Lilac's provider UI.
  // If the watcher is unavailable, new settings are read when playback changes.
  let registryWatcher = null;
  try {
    await fs.mkdir(path.dirname(sourceRegistry.file), { recursive: true });
    registryWatcher = watchFs(path.dirname(sourceRegistry.file), (_event, name) => {
      const changed = String(name || '').toLowerCase();
      if (!name || changed === path.basename(sourceRegistry.file).toLowerCase()) registryDirty = true;
      if (!name || changed === path.basename(animePolicies.file).toLowerCase()) policiesDirty = true;
    });
    registryWatcher.on('error', error => {
      console.warn(`[companion] source settings watcher unavailable: ${error?.message || error}`);
      try { registryWatcher?.close(); } catch {}
      registryWatcher = null;
    });
    registryWatcher.unref?.();
  } catch (error) {
    console.warn(`[companion] source settings watch disabled: ${error?.message || error}`);
  }

  const stopRuntime = () => {
    try { stopMenuShortcut(); } catch {}
    try { registryWatcher?.close(); } catch {}
    try { subtitleWatcher?.close(); } catch {}
    try { connection?.session?.close(); } catch {}
    connection = null;
  };

  const switchSource = async (bridge, live, selected, reason, {
    cached = false, early = false, entryStartedAt = 0,
    expectedSession = '', expectedPolicy = null
  } = {}) => {
    if (!selected?.provider || selected.provider === live.episode?.provider) return false;
    if (expectedSession && activeSourceSession(live) !== expectedSession) return false;
    if (!early && !withinSourceSwitchWindow(entryStartedAt, { maxSeconds: sourceAutoSwitchMaxSeconds })) {
      console.log('[companion] source switch skipped: diagnosis finished outside the automatic switch window');
      return false;
    }
    if (sourceAutoMode !== 'safe' && sourceAutoMode !== 'on') return false;
    // A separate CLI process may change either global or per-anime rules
    // while an asynchronous scan is running.
    await sourceRegistry.load();
    await animePolicies.load();
    const livePolicy = animePolicies.resolve(live);
    const livePlan = managedSourcePlan(sourceRegistry.plan(live.episode?.provider), livePolicy);
    if (JSON.stringify(livePolicy) !== JSON.stringify(expectedPolicy) ||
        livePlan.disabledCurrent || !livePlan.providers.includes(selected.provider) ||
        (livePolicy?.locked && selected.provider !== livePolicy.preferred)) {
      console.log('[companion] source switch cancelled: source policy changed');
      return false;
    }
    // Recheck the renderer immediately before switching: returning to a video
    // counts as a new session, not a manual override.
    const current = await bridge.playbackContext();
    if (activeSourceSession(current) !== activeSourceSession(live)) return false;
    console.log('[companion] ' + (cached ? 'cached ' : '') + 'auto-switching source: ' +
      live.episode.provider + ' -> ' + selected.provider + ' (' + reason + ')');
    sourceSwitchGuard = { episodeKey: sourceEpisodeKey(live), provider: selected.provider, session: '', until: Date.now() + 60000 };
    await bridge.switchToResolvedSource(selected, {
      title: live.anime.title || live.anime.title_english || live.anime.romaji || '',
      resumeSeconds: Number(live.currentTime || 0),
      resumeDuration: Number(live.playback?.duration || 0)
    });
    handledRef = '';
    lastAttachedPath = '';
    lastObservedUserSubtitleKey = '';
    return true;
  };

  const startSourceDiagnosis = context => {
    const session = activeSourceSession(context);
    if (sourceAutoMode === 'off' || !liveInventoryTrusted || !session) return;
    const policy = animePolicies.resolve(context);
    const plan = managedSourcePlan(sourceRegistry.plan(context.episode.provider), policy);
    if (plan.disabledCurrent || !plan.providers.length) return;
    // This cooldown prevents loops caused by *our own* automatic switch. It
    // does not infer or remember any user's manual source-selection intent.
    if (sourceSwitchGuard.until > Date.now()
        && sourceSwitchGuard.episodeKey === sourceEpisodeKey(context)
        && sourceSwitchGuard.provider === context.episode.provider) {
      if (!sourceSwitchGuard.session) sourceSwitchGuard.session = session;
      if (sourceSwitchGuard.session === session) return;
    }
    const key = sourceEpisodeKey(context); // Episode cache survives re-entry.
    const taskKey = session;                 // In-flight tasks never cross entries.
    if (!key || sourceTasks.has(taskKey)) return;

    const cached = sourceDecisions.get(key);
    if (cached) {
      const cachedScan = withAnimePolicy(cached.scan, policy);
      const cachedSafety = decideWithAnimePolicy(cachedScan, context.episode.provider, policy);
      if (!cachedSafety.switch) return;
      const task = (async () => {
        let cachedConnection = null;
        try {
          await sleep(350);
          cachedConnection = await connectBridge({ launch: false });
          const live = await cachedConnection.bridge.playbackContext();
          if (activeSourceSession(live) !== session) return;
          const scan = withAnimePolicy(cached.scan, policy);
          const safety = decideWithAnimePolicy(scan, live.episode.provider, policy);
          const selected = scan.decision?.selected;
          console.log('[companion] cached source recommendation: ' +
            (selected?.provider || 'none') + ' · ' + safety.reason);
          if (!safety.switch) return;
          await switchSource(cachedConnection.bridge, live, safety.selected, safety.reason,
            { cached: true, early: true, expectedSession: session, expectedPolicy: policy });
        } catch (error) {
          console.warn('[companion] cached source switch failed; fresh scan allowed later: ' +
            (error?.message || error));
          sourceDecisions.clear(key);
          sourceDecisions.defer(key);
        } finally {
          try { cachedConnection?.session?.close(); } catch {}
        }
      })().finally(() => sourceTasks.delete(taskKey));
      sourceTasks.set(taskKey, task);
      return;
    }

    if (!sourceDecisions.canScan(key)) return;
    const entryStartedAt = Date.now();
    const task = (async () => {
      let diagnosisConnection = null;
      try {
        await sleep(1200);
        diagnosisConnection = await connectBridge({ launch: false });
        const start = await diagnosisConnection.bridge.playbackContext();
        if (activeSourceSession(start) !== session) return;
        console.log('[companion] source scan started: ' +
          (start.anime.title || start.anime.title_english) + ' · E' +
          start.episode.number + ' (current ' + start.episode.provider + ')');
        const quickRaw = await scanSources(diagnosisConnection.bridge, start,
          { sampleCount: 1, concurrency: 2, providers: plan.providers, includeCurrent: false });
        const afterQuick = await diagnosisConnection.bridge.playbackContext().catch(() => null);
        if (activeSourceSession(afterQuick) !== session) {
          console.log('[companion] source scan cancelled: playback session ended or changed');
          return;
        }
        const quick = withAnimePolicy(quickRaw, policy);
        printSourceScan('auto quick scan (managed providers)', quick);
        await sourceRegistry.reportScan(quick.results);
        await animePolicies.load();
        const latestPolicy = animePolicies.resolve(start);
        const refreshedPlan = managedSourcePlan(sourceRegistry.plan(start.episode.provider), latestPolicy);
        if (refreshedPlan.disabledCurrent || refreshedPlan.signature !== plan.signature) {
          console.log('[companion] source scan cancelled: inventory/mode/anime rule changed during probing');
          return;
        }
        const quickSafety = decideWithAnimePolicy(quick, start.episode.provider, policy);
        if (allowQuickAutoSwitch(quick, quickSafety)) {
          console.log('[companion] source recommendation (quick): ' +
            (quick.decision?.selected?.provider || 'none') + ' · ' + quickSafety.reason);
          sourceDecisions.remember(key, quick, Date.now(), sourceQuickDecisionCacheMs);
          if (await switchSource(diagnosisConnection.bridge, afterQuick, quickSafety.selected, quickSafety.reason,
            { early: true, expectedSession: session, expectedPolicy: policy })) return;
        }
        // Excluded providers cannot use one of the three deep-probe slots.
        const deepCandidateQuick = policy
          ? { ...quick, results: quick.results.filter(row => !policy.excluded.includes(row.provider)) }
          : quick;
        const deepRaw = await deepScanTop(diagnosisConnection.bridge, deepCandidateQuick,
          { count: 3, sampleCount: 3, intensiveProviders: plan.intensive, includeCurrent: false });
        const afterDeep = await diagnosisConnection.bridge.playbackContext().catch(() => null);
        if (activeSourceSession(afterDeep) !== session) {
          console.log('[companion] source scan cancelled: playback session ended or changed');
          return;
        }
        const deep = withAnimePolicy(deepRaw, policy);
        printSourceScan('auto deep scan (top providers)', deep);
        const selected = deep.decision?.selected;
        const safety = decideWithAnimePolicy(deep, start.episode.provider, policy);
        if (selected) sourceDecisions.remember(key, deep);
        else sourceDecisions.defer(key);
        console.log('[companion] source recommendation: ' +
          (selected?.provider || 'none') + ' · ' + safety.reason);
        if (!safety.switch) return;
        await switchSource(diagnosisConnection.bridge, afterDeep, safety.selected, safety.reason,
          { entryStartedAt, expectedSession: session, expectedPolicy: policy });
      } finally {
        try { diagnosisConnection?.session?.close(); } catch {}
      }
    })().catch(error => {
      console.warn('[companion] source scan failed: ' + (error?.message || error));
      sourceDecisions.defer(key);
    }).finally(() => sourceTasks.delete(taskKey));

    sourceTasks.set(taskKey, task);
  };

  try {
    for (;;) {
      try {
        if (!connection) {
          if (everConnected) {
            const running = Boolean(await runningLilacExecutable());
            const action = lilacRecoveryAction({ everConnected, lilacRunning: running });
            if (action === 'exit') {
              console.log('[companion] Lilac has been closed; Companion is exiting too.');
              return;
            }
          }
          connection = await connectBridge({ launch: !everConnected });
          everConnected = true;
          const features = await connection.bridge.features();
          console.log(`[companion] connected: ${connection.target.title || connection.target.url}`);
          console.log(`[companion] features: ${JSON.stringify(features)}`);
          handledRef = '';
          lastObservedUserSubtitleKey = '';
          // Only inspect the provider UI on a new Lilac/CDP connection. A
          // program update causes a new connection on its next launch.
          liveInventoryTrusted = false;
          try {
            const inventory = await sourceRegistry.refreshFromBridge(connection.bridge);
            liveInventoryTrusted = inventory.reliable;
            printSourceChanges(inventory);
          } catch (error) {
            console.warn(`[companion] source inventory discovery unavailable: ${error?.message || error}`);
          }
          const refreshedSignature = sourceRegistry.plan().signature;
          if (refreshedSignature !== lastRegistrySignature) {
            sourceDecisions.clear();
            lastRegistrySignature = refreshedSignature;
          }
        }

        if (policiesDirty) {
          policiesDirty = false;
          const previous = lastPolicySignature;
          await animePolicies.load();
          lastPolicySignature = animePolicies.signature();
          if (previous !== lastPolicySignature) {
            sourceDecisions.clear();
            console.log('[companion] anime source policies changed; cached decisions cleared');
          }
        }

        if (registryDirty) {
          registryDirty = false;
          const previous = lastRegistrySignature;
          await sourceRegistry.load();
          lastRegistrySignature = sourceRegistry.plan().signature;
          if (previous !== lastRegistrySignature) {
            sourceDecisions.clear();
            console.log('[companion] source settings changed; cached decisions cleared');
          }
        }

        const shouldRefreshForChange = subtitlesDirty && Date.now() - subtitleChangedAt >= 500;
        const safetyInterval = subtitleWatcher ? subtitleSafetyScanMs : 60_000;
        const shouldSafetyRefresh = Date.now() - indexedAt > safetyInterval;
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
        if (!context?.activePlayer || !context?.anime || !context?.episode?.number) {
          if (!context?.activePlayer) {
            handledRef = '';
            lastAttachedPath = '';
            lastObservedUserSubtitleKey = '';
          }
          await sleep(900);
          continue;
        }
        const ref = playbackRef(state, context);
        // A fallback for platforms where the file watcher was unavailable.
        if (!registryWatcher && ref !== handledRef) {
          const previous = lastRegistrySignature;
          await sourceRegistry.load();
          lastRegistrySignature = sourceRegistry.plan().signature;
          if (previous !== lastRegistrySignature) sourceDecisions.clear();
          const previousPolicies = lastPolicySignature;
          await animePolicies.load();
          lastPolicySignature = animePolicies.signature();
          if (previousPolicies !== lastPolicySignature) sourceDecisions.clear();
        }

        const userSubtitlePath = context.subtitle?.source === 'user' ? String(context.subtitle.path || '') : '';
        if (userSubtitlePath && userSubtitlePath !== lastAttachedPath && await exists(userSubtitlePath)) {
          const userSelectionKey = `${ref}|${path.resolve(userSubtitlePath).toLowerCase()}`;
          if (userSelectionKey !== lastObservedUserSubtitleKey) {
            lastObservedUserSubtitleKey = userSelectionKey;
            const compatibility = isUserSubtitleCompatibleWithEpisode(userSubtitlePath, context.episode.number);
            if (!compatibility.compatible) {
              console.log(`[companion] ignored stale user subtitle from E${compatibility.hintedEpisode} while playing E${context.episode.number}: ${userSubtitlePath}`);
            } else {
              const changed = await state.rememberSubtitle(context.anime, context.episode.number, { path: userSubtitlePath, kind: 'user' });
              handledRef = ref;
              if (changed) console.log(`[companion] remembered user subtitle: ${userSubtitlePath}`);
              startSourceDiagnosis(context);
              await sleep(900);
              continue;
            }
          }
        }

        if (ref === handledRef) {
          startSourceDiagnosis(context);
          await sleep(900);
          continue;
        }
        console.log(`[companion] playback detected: ${context.anime.title || context.anime.title_english || context.anime.romaji || 'unknown'} · E${context.episode.number} · entry ${context.playbackSessionId || 0}`);
        await sleep(650);
        const stable = await connection.bridge.playbackContext();
        if (!stable?.anime || playbackRef(state, stable) !== ref || !activeSourceSession(stable)) continue;
        await recentlyPlayed.record(stable).catch(error =>
          console.warn('[companion] recent anime save skipped: ' + (error?.message || error)));

        let preference = state.subtitlePreference(stable.anime, stable.episode.number);
        let manual = preference?.kind === 'user' ? preference : null;
        if (manual?.path) {
          const compatibility = isUserSubtitleCompatibleWithEpisode(manual.path, stable.episode.number);
          if (!compatibility.compatible) {
            await state.forgetSubtitle(stable.anime, stable.episode.number);
            console.log(`[companion] removed stale remembered subtitle for E${stable.episode.number} (file looks like E${compatibility.hintedEpisode}): ${manual.path}`);
            preference = null;
            manual = null;
          }
        }
        const cachedAliases = state.titleAliases(stable.anime);
        const resolved = await chooseLocalSubtitleWithFallback(connection.bridge, {
          anime: stable.anime,
          episode: stable.episode.number,
          episodeMeta: stable.episode,
          aliases: cachedAliases,
          files: index.files,
          manual
        });
        const match = resolved.match;
        if (resolved.fallback.length) {
          console.log(`[companion] local title alias resolved: ${resolved.fallback.slice(0, 8).join(' | ')}`);
          await state.rememberTitleAliases(stable.anime, resolved.fallback);
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
        if (everConnected) {
          await sleep(1200);
          const running = Boolean(await runningLilacExecutable());
          const action = lilacRecoveryAction({ everConnected, lilacRunning: running });
          if (action === 'exit') {
            console.log('[companion] Lilac has been closed; Companion is exiting too.');
            return;
          }
          console.warn('[companion] Lilac is still running; retrying CDP attach without relaunching Lilac.');
        } else {
          await sleep(1500);
        }
      }
    }
  } finally {
    stopRuntime();
  }
}

if (command === 'version' || command === '--version' || command === '-v') console.log(`Lilac Companion ${VERSION}`);
else if (command === 'doctor') await doctor();
else if (command === 'source-doctor') await sourceDoctor();
else if (command === 'help' || command === '--help' || command === '-h') printHelp();
else if (command === 'sources' && process.argv[3] === 'menu') await sourceMenu();
else if (command === 'sources' && process.argv[3] === 'help') printHelp();
else if (command === 'sources') await sourcesCommand(process.argv[3] || 'list', process.argv[4] || '');
else if (command === 'watch') {
  await watch();
  process.exit(0);
} else throw new Error(`Unknown command: ${command}`);
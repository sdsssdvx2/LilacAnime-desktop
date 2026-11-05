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
    const plan = registry.plan(context.episode.provider, { ignoreCooldown: true });
    if (plan.disabledCurrent || !plan.providers.includes(context.episode.provider)) {
      console.log('[companion] current source excluded or absent from Lilac; no automatic probing');
      return;
    }
    console.log(`[companion] source doctor: ${context.anime.title || context.anime.title_english} · E${context.episode.number}`);
    const quick = await scanSources(bridge, context, { sampleCount: 1, providers: plan.providers, includeCurrent: false });
    printSourceScan('quick scan (managed sources)', quick);
    await registry.reportScan(quick.results);
    const deep = await deepScanTop(bridge, quick, { count: 3, sampleCount: 3, intensiveProviders: plan.intensive, includeCurrent: false });
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
  const state = await new StateStore().load();
  const sourceRegistry = await new SourceRegistry().load();
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
  let sourceSwitchGuard = { episode: null, provider: '', until: 0 };
  let liveInventoryTrusted = false;
  let registryDirty = false;
  let lastRegistrySignature = sourceRegistry.plan().signature;
  console.log(`[companion] version: ${VERSION}`);
  console.log(`[companion] indexed ${index.files.length} subtitle files from ${subtitleRoot}`);
  console.log(`[companion] source auto mode: ${sourceAutoMode}`);

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
      if (!name || String(name).toLowerCase() === path.basename(sourceRegistry.file).toLowerCase()) registryDirty = true;
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
    try { registryWatcher?.close(); } catch {}
    try { subtitleWatcher?.close(); } catch {}
    try { connection?.session?.close(); } catch {}
    connection = null;
  };

  const switchSource = async (bridge, live, selected, reason, { cached = false, early = false, entryStartedAt = 0 } = {}) => {
    if (!selected?.provider || selected.provider === live.episode?.provider) return false;
    if (!early && !withinSourceSwitchWindow(entryStartedAt, { maxSeconds: sourceAutoSwitchMaxSeconds })) {
      console.log('[companion] source switch skipped: diagnosis finished outside the automatic switch window');
      return false;
    }
    if (sourceAutoMode !== 'safe' && sourceAutoMode !== 'on') return false;
    // A manual 'sources off' issued during a scan must take effect before switching.
    await sourceRegistry.load();
    const livePlan = sourceRegistry.plan(live.episode?.provider);
    if (livePlan.disabledCurrent || !livePlan.providers.includes(selected.provider)) {
      console.log('[companion] source switch cancelled: source policy changed');
      return false;
    }
    console.log(`[companion] ${cached ? 'cached ' : ''}auto-switching source: ${live.episode.provider} -> ${selected.provider} (${reason})`);
    sourceSwitchGuard = { episode: Number(live.episode.number), provider: selected.provider, until: Date.now() + 60000 };
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
    if (sourceAutoMode === 'off' || !liveInventoryTrusted || !context?.anime || !context?.episode?.number) return;
    const plan = sourceRegistry.plan(context.episode.provider);
    if (plan.disabledCurrent || !plan.providers.includes(context.episode.provider)) return;
    if (sourceSwitchGuard.until > Date.now()
        && sourceSwitchGuard.episode === Number(context.episode.number)
        && sourceSwitchGuard.provider === context.episode.provider) return;
    const key = sourceEpisodeKey(context);
    if (!key || sourceTasks.has(key)) return;

    const cached = sourceDecisions.get(key);
    if (cached) {
      const cachedSafety = safeAutoSwitchDecision(cached.scan, context.episode.provider);
      if (!cachedSafety.switch) return;

      const task = (async () => {
        let cachedConnection = null;
        try {
          await sleep(350);
          cachedConnection = await connectBridge({ launch: false });
          const live = await cachedConnection.bridge.playbackContext();
          if (!live?.anime || sourceEpisodeKey(live) !== key || live.episode?.provider !== context.episode?.provider) return;
          const safety = safeAutoSwitchDecision(cached.scan, live.episode.provider);
          const selected = cached.scan?.decision?.selected;
          console.log(`[companion] cached source recommendation: ${selected?.provider || 'none'} · ${safety.reason}`);
          if (!safety.switch) return;
          await switchSource(cachedConnection.bridge, live, safety.selected, safety.reason, { cached: true, early: true });
        } catch (error) {
          console.warn(`[companion] cached source switch failed; a fresh scan will be allowed later: ${error?.message || error}`);
          sourceDecisions.clear(key);
          sourceDecisions.defer(key);
        } finally {
          try { cachedConnection?.session?.close(); } catch {}
        }
      })().finally(() => sourceTasks.delete(key));
      sourceTasks.set(key, task);
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
        if (!start?.anime || sourceEpisodeKey(start) !== key) return;
        console.log(`[companion] source scan started: ${start.anime.title || start.anime.title_english} · E${start.episode.number} (current ${start.episode.provider})`);
        const quick = await scanSources(diagnosisConnection.bridge, start, { sampleCount: 1, concurrency: 2, providers: plan.providers, includeCurrent: false });
        const afterQuick = await diagnosisConnection.bridge.playbackContext().catch(() => null);
        if (!afterQuick?.anime || sourceEpisodeKey(afterQuick) !== key) {
          console.log('[companion] source scan cancelled: playback changed during quick scan');
          return;
        }
        printSourceScan('auto quick scan (managed providers)', quick);
        await sourceRegistry.reportScan(quick.results);
        const refreshedPlan = sourceRegistry.plan(start.episode.provider);
        if (refreshedPlan.disabledCurrent || refreshedPlan.signature !== plan.signature) {
          console.log('[companion] source scan cancelled: inventory/mode/cooldown changed during probing');
          return;
        }

        const quickSafety = safeAutoSwitchDecision(quick, start.episode.provider);
        if (afterQuick.episode?.provider === start.episode?.provider && allowQuickAutoSwitch(quick, quickSafety)) {
          console.log(`[companion] source recommendation (quick): ${quick.decision?.selected?.provider || 'none'} · ${quickSafety.reason}`);
          sourceDecisions.remember(key, quick, Date.now(), sourceQuickDecisionCacheMs);
          if (await switchSource(diagnosisConnection.bridge, afterQuick, quickSafety.selected, quickSafety.reason, { early: true })) return;
        }

        const deep = await deepScanTop(diagnosisConnection.bridge, quick, { count: 3, sampleCount: 3, intensiveProviders: plan.intensive, includeCurrent: false });
        const afterDeep = await diagnosisConnection.bridge.playbackContext().catch(() => null);
        if (!afterDeep?.anime || sourceEpisodeKey(afterDeep) !== key) {
          console.log('[companion] source scan cancelled: playback changed during deep scan');
          return;
        }
        printSourceScan('auto deep scan (top providers)', deep);
        const selected = deep.decision?.selected;
        const safety = safeAutoSwitchDecision(deep, start.episode.provider);
        if (selected) sourceDecisions.remember(key, deep);
        else sourceDecisions.defer(key);
        console.log(`[companion] source recommendation: ${selected?.provider || 'none'} · ${safety.reason}`);

        const live = afterDeep;
        if (live.episode?.provider !== start.episode?.provider) {
          console.log(`[companion] source switch skipped: provider changed during active scan (${start.episode.provider} -> ${live.episode.provider}); treating it as a user override`);
          return;
        }
        if (!safety.switch) return;
        await switchSource(diagnosisConnection.bridge, live, safety.selected, safety.reason, { entryStartedAt });
      } finally {
        try { diagnosisConnection?.session?.close(); } catch {}
      }
    })().catch(error => {
      console.warn(`[companion] source scan failed: ${error?.message || error}`);
      sourceDecisions.defer(key);
    }).finally(() => sourceTasks.delete(key));

    sourceTasks.set(key, task);
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
        if (!context?.anime || !context?.episode?.number) {
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
        if (!stable?.anime || playbackRef(state, stable) !== ref) continue;

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
else if (command === 'sources') await sourcesCommand(process.argv[3] || 'list', process.argv[4] || '');
else if (command === 'watch') {
  await watch();
  process.exit(0);
} else throw new Error(`Unknown command: ${command}`);
import http from 'node:http';
import { connectLilacCdp, loadCdpNetworkResource } from '../src/lilac/cdp.mjs';
import { LilacBridge } from '../src/lilac/bridge.mjs';

const port = Number(process.env.LILAC_CDP_PORT || 9223);
const required = [
  'lilac',
  'titleVariants',
  'resolveTitles',
  'catalogKoreanSearch',
  'providerCatalog',
  'providerDetail',
  'prepareEpisodeStream',
  'linkkfSearch',
  'linkkfEpisodes',
  'attachSubtitle',
  'playbackContext',
  'resolveIntoPlayer'
];

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

const { session, target } = await connectLilacCdp({ port });
try {
  const bridge = new LilacBridge(session);
  await bridge.waitUntilReady({ timeoutMs: 20000, intervalMs: 200 });
  const features = await bridge.features();
  console.log(JSON.stringify({ target: { title: target.title || '', url: target.url || '' }, features }, null, 2));
  const missing = required.filter(key => features[key] !== true);
  if (missing.length) {
    console.error(`Missing required Lilac bridge features: ${missing.join(', ')}`);
    process.exitCode = 2;
  }

  const probeServer = http.createServer((req, res) => {
    if (req.headers['x-companion-probe'] !== 'yes') {
      res.writeHead(403, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
      res.end('forbidden');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    res.end('selective-browser-probe-ok');
  });
  const probeAddress = await listen(probeServer);
  try {
    const resource = await loadCdpNetworkResource(
      session,
      `http://127.0.0.1:${probeAddress.port}/protected`,
      { headers: { 'X-Companion-Probe': 'yes' }, timeoutMs: 5000 }
    );
    const browserProbe = { status: resource.status, body: resource.body.toString('utf8') };
    console.log(JSON.stringify({ browserProbe }, null, 2));
    if (browserProbe.status !== 200 || browserProbe.body !== 'selective-browser-probe-ok') {
      console.error('Companion selective CDP headers could not load a protected network resource');
      process.exitCode = 7;
    }
  } finally {
    await closeServer(probeServer);
  }

  await session.evaluate(`(() => {
    currentPlaybackContext = { seriesEpisodes: Array.from({ length: 26 }, (_, i) => ({ number: i + 1 })) };
    if (typeof playbackRequestId !== 'undefined') playbackRequestId = 41;
    document.body.classList.add('player-mode');
    const view = document.querySelector('#playerView');
    if (view) view.classList.add('active');
    const title = document.querySelector('#playerTitle');
    if (title) title.textContent = 'Sword of Coming · 1화';
    localStorage.setItem('contentSource', 'reanime');
    return true;
  })()`);
  const recovered = await bridge.playbackContext();
  console.log(JSON.stringify({ recoveredPlayback: recovered }, null, 2));
  const recoveredOk = recovered?.anime?.title === 'Sword of Coming'
    && Number(recovered?.episode?.number) === 1
    && recovered?.episode?.provider === 'reanime'
    && recovered?.activePlayer === true
    && Number(recovered?.playbackSessionId) === 41
    && recovered?.anime?.companionSeriesEpisodes?.length === 26;
  if (!recoveredOk) {
    console.error('Companion could not recover playback identity/session from the active Lilac player DOM');
    process.exitCode = 3;
  }

  await session.evaluate(`(() => {
    if (typeof playbackRequestId !== 'undefined') playbackRequestId = 42;
    const title = document.querySelector('#playerTitle');
    if (title) title.textContent = 'Sword of Coming · 1화';
    return true;
  })()`);
  const reentered = await bridge.playbackContext();
  console.log(JSON.stringify({ reenteredPlayback: reentered }, null, 2));
  if (Number(reentered?.episode?.number) !== 1 || Number(reentered?.playbackSessionId) !== 42) {
    console.error('Companion could not distinguish re-entering the same episode as a new playback entry');
    process.exitCode = 4;
  }

  const patched = await session.evaluate(`(() => {
    try {
      window.__companionOriginalResolveIntoPlayer = resolveIntoPlayer;
      resolveIntoPlayer = async (...args) => { window.__companionSwitchArgs = args; return true; };
      window.__companionOriginalProviderResolve = window.lilac.providerResolve;
      window.lilac.providerResolve = async episode => ({ url: 'https://example.invalid/video.m3u8', episode });
      return true;
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  })()`);
  if (patched !== true) {
    console.error(`Could not install source-switch integration shim: ${JSON.stringify(patched)}`);
    process.exitCode = 5;
  } else {
    await bridge.switchToResolvedSource({
      provider: 'miruro',
      anime: { title: 'Sword of Coming' },
      episode: { provider: 'miruro', id: 'episode-1', number: 1, name: '1화' },
      seriesEpisodes: [{ number: 1 }, { number: 2 }]
    }, { title: 'Sword of Coming', resumeSeconds: 600, resumeDuration: 1200 });
    const captured = await session.evaluate(`(() => {
      const args = window.__companionSwitchArgs || [];
      const context = args[2] || {};
      return { resumeSeconds: context.resumeSeconds, resumeProgress: context.resumeProgress, provider: context.episode?.provider, seriesEpisodes: context.seriesEpisodes?.length || 0 };
    })()`);
    console.log(JSON.stringify({ sourceSwitchResume: captured }, null, 2));
    const resumeOk = Number(captured?.resumeSeconds) === 600
      && Math.abs(Number(captured?.resumeProgress) - 50) < 0.001
      && captured?.provider === 'miruro'
      && Number(captured?.seriesEpisodes) === 2;
    if (!resumeOk) {
      console.error('Companion source switch did not preserve the current playback position through Lilac resolveIntoPlayer context');
      process.exitCode = 6;
    }
  }
} finally {
  try {
    await session.evaluate(`(() => {
      if (window.__companionOriginalResolveIntoPlayer) resolveIntoPlayer = window.__companionOriginalResolveIntoPlayer;
      if (window.__companionOriginalProviderResolve) window.lilac.providerResolve = window.__companionOriginalProviderResolve;
      delete window.__companionOriginalResolveIntoPlayer;
      delete window.__companionOriginalProviderResolve;
      delete window.__companionSwitchArgs;
      return true;
    })()`);
  } catch {}
  session.close();
}

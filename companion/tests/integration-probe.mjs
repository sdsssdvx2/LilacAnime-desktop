import http from 'node:http';
import { connectLilacCdp } from '../src/lilac/cdp.mjs';
import { LilacBridge } from '../src/lilac/bridge.mjs';
import { probeHlsViaCdp } from '../src/source/browser-hls-probe.mjs';

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

  // Exercise discovery against the real official Lilac renderer (no provider network calls).
  const inventory = await bridge.listProviders();
  console.log(JSON.stringify({ liveSourceInventory: inventory }, null, 2));
  if (!inventory.reliable || inventory.providers.length < 2) {
    console.error('Official Lilac video-source controls could not be discovered safely');
    process.exitCode = 8;
  } else {
    const injected = await session.evaluate(`(() => {
      const select = document.querySelector('#contentSource');
      const choices = document.querySelector('#sourceChoices');
      if (!select || !choices || select.querySelector('[value="companionfixture"]')) return false;
      const option = document.createElement('option');
      option.value = 'companionfixture';
      option.textContent = 'Fixture Source';
      select.append(option);
      const button = document.createElement('button');
      button.dataset.value = 'companionfixture';
      button.textContent = 'Fixture Source';
      choices.append(button);
      return true;
    })()`);
    if (injected) {
      try {
        const updated = await bridge.listProviders();
        if (!updated.reliable || !updated.providers.some(item => item.id === 'companionfixture')) {
          console.error('New video source was not discovered in official Lilac DOM');
          process.exitCode = 9;
        }
      } finally {
        await session.evaluate(`(() => {
          document.querySelector('#contentSource option[value="companionfixture"]')?.remove();
          document.querySelector('#sourceChoices [data-value="companionfixture"]')?.remove();
          return true;
        })()`);
      }
      const restored = await bridge.listProviders();
      if (!restored.reliable || restored.providers.some(item => item.id === 'companionfixture')) {
        console.error('Removed video source was not reflected in official Lilac DOM');
        process.exitCode = 10;
      }
    } else {
      console.error('Could not inject source fixture into official Lilac DOM');
      process.exitCode = 11;
    }
  }

  const segment = Buffer.alloc(64 * 1024, 0x5a);
  const probeServer = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*' };
    if (req.headers['x-companion-probe'] !== 'yes') {
      res.writeHead(403, { ...cors, 'content-type': 'text/plain' });
      res.end('forbidden');
      return;
    }
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { ...cors, 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,AVERAGE-BANDWIDTH=1700000,RESOLUTION=1920x1080,CODECS="avc1.640028"\nmedia.m3u8\n');
      return;
    }
    if (req.url === '/media.m3u8') {
      res.writeHead(200, { ...cors, 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n#EXT-X-ENDLIST\n');
      return;
    }
    if (/^\/seg[0-2]\.ts$/.test(req.url || '')) {
      res.writeHead(200, { ...cors, 'content-type': 'video/mp2t', 'content-length': String(segment.length) });
      res.end(segment);
      return;
    }
    res.writeHead(404, cors);
    res.end();
  });
  const probeAddress = await listen(probeServer);
  try {
    const browserHls = await probeHlsViaCdp(
      session,
      `http://127.0.0.1:${probeAddress.port}/master.m3u8`,
      { headers: { 'X-Companion-Probe': 'yes' }, sampleCount: 3, timeoutMs: 5000 }
    );
    console.log(JSON.stringify({ browserHls: {
      height: browserHls.quality?.height,
      expectedMbps: browserHls.metrics?.expectedMbps,
      samples: browserHls.samples?.length,
      failureRate: browserHls.metrics?.failureRate,
      browserProbe: browserHls.browserProbe
    } }, null, 2));
    const hlsOk = browserHls.browserProbe === true
      && Number(browserHls.quality?.height) === 1080
      && Number(browserHls.samples?.length) === 3
      && Number(browserHls.metrics?.failureRate) === 0;
    if (!hlsOk) {
      console.error('Companion browser HLS fallback could not read a header-protected HLS stream');
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

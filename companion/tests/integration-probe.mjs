import { connectLilacCdp } from '../src/lilac/cdp.mjs';
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
} finally {
  session.close();
}

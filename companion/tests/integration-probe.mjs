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
} finally {
  session.close();
}

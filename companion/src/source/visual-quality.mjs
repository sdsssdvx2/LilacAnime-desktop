import { extractGrayFrame } from './ffmpeg-media.mjs';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function streamHeaders(stream = {}) {
  const raw = stream.headers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const headers = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
  if (stream.referer && !Object.keys(headers).some(key => key.toLowerCase() === 'referer')) headers.Referer = String(stream.referer);
  return headers;
}

export function frameSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < a.length; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / a.length, meanB = sumB / b.length;
  let numerator = 0, sqA = 0, sqB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    numerator += da * db;
    sqA += da * da;
    sqB += db * db;
  }
  const denominator = Math.sqrt(sqA * sqB);
  return denominator > 0 ? clamp(numerator / denominator, -1, 1) : 0;
}

export function frameMetrics(frame, width, height) {
  if (!frame || frame.length !== width * height || width < 16 || height < 16) throw new Error('invalid grayscale frame');
  let sum = 0, sumSq = 0;
  for (const value of frame) { sum += value; sumSq += value * value; }
  const mean = sum / frame.length;
  const variance = Math.max(0, sumSq / frame.length - mean * mean);
  const std = Math.max(6, Math.sqrt(variance));

  let edgeSum = 0, lapSum = 0, edgeCount = 0;
  let boundarySum = 0, boundaryCount = 0, innerSum = 0, innerCount = 0;
  let flatNoiseSum = 0, flatCount = 0;
  const idx = (x, y) => y * width + x;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const c = frame[idx(x, y)];
      const dx = Math.abs(c - frame[idx(x - 1, y)]);
      const dy = Math.abs(c - frame[idx(x, y - 1)]);
      const edge = dx + dy;
      const lap = Math.abs(4 * c - frame[idx(x - 1, y)] - frame[idx(x + 1, y)] - frame[idx(x, y - 1)] - frame[idx(x, y + 1)]);
      edgeSum += edge;
      lapSum += lap;
      edgeCount++;
      if (x % 8 === 0) { boundarySum += dx; boundaryCount++; }
      else if (x % 8 === 4) { innerSum += dx; innerCount++; }
      if (y % 8 === 0) { boundarySum += dy; boundaryCount++; }
      else if (y % 8 === 4) { innerSum += dy; innerCount++; }
      if (edge <= Math.max(6, std * 0.16)) { flatNoiseSum += lap; flatCount++; }
    }
  }
  const edgeMean = edgeCount ? edgeSum / edgeCount / std : 0;
  const lapMean = edgeCount ? lapSum / edgeCount / std : 0;
  const boundaryMean = boundaryCount ? boundarySum / boundaryCount : 0;
  const innerMean = innerCount ? innerSum / innerCount : 0;
  const blockiness = innerMean > 0 ? boundaryMean / innerMean : 1;
  const flatNoise = flatCount ? flatNoiseSum / flatCount / std : 0;
  return { mean, std, edgeMean, lapMean, blockiness, flatNoise };
}

function relativeScore(metrics, anchor) {
  const logRatio = (a, b) => clamp(Math.log((a + 0.001) / (b + 0.001)), -0.55, 0.55);
  return 0.42 * logRatio(metrics.edgeMean, anchor.edgeMean)
    + 0.58 * logRatio(metrics.lapMean, anchor.lapMean)
    - 0.24 * logRatio(metrics.blockiness, anchor.blockiness)
    - 0.14 * logRatio(metrics.flatNoise, anchor.flatNoise);
}

function sampleTimes(duration) {
  const d = Number(duration || 0);
  if (d >= 600) return [clamp(d * 0.28, 75, 420), clamp(d * 0.62, 180, Math.max(180, d - 90))];
  if (d >= 180) return [clamp(d * 0.30, 35, d - 70), clamp(d * 0.66, 80, d - 30)];
  if (d > 40) return [Math.max(12, d * 0.28), Math.max(24, d * 0.62)];
  return [30, 90];
}

function commonDuration(entries, context) {
  const live = Number(context?.playback?.duration || 0);
  if (live > 0) return live;
  const durations = entries.map(entry => Number(entry?.probe?.quality?.duration || 0)).filter(value => value > 0);
  return durations.length ? Math.min(...durations) : null;
}

export async function compareVisualSources(entries, {
  context = null,
  currentProvider = '',
  maxSources = 2,
  width = 640,
  height = 360,
  similarityThreshold = 0.86,
  timeoutMs = 8500
} = {}) {
  const candidates = entries
    .filter(entry => entry?.provider && entry?.stream?.url && /^https?:\/\//i.test(entry.stream.url) && entry?.probe)
    .sort((a, b) => Number(b.probe?.metrics?.stability || 0) - Number(a.probe?.metrics?.stability || 0))
    .slice(0, Math.max(2, maxSources));
  if (candidates.length < 2) return { available: false, confidence: 'none', reason: 'not-enough-comparable-sources' };

  const heights = candidates.map(entry => Number(entry.probe?.quality?.height || 0)).filter(Boolean);
  if (heights.length < candidates.length || Math.max(...heights) !== Math.min(...heights)) {
    return { available: false, confidence: 'none', reason: 'resolution-not-equal' };
  }

  const anchor = candidates.find(entry => entry.provider === currentProvider) || candidates[0];
  const times = sampleTimes(commonDuration(candidates, context));
  const scores = new Map(candidates.map(entry => [entry.provider, []]));
  const similarities = new Map(candidates.map(entry => [entry.provider, []]));

  for (const time of times) {
    let anchorFrame;
    try {
      anchorFrame = await extractGrayFrame(anchor.stream.url, { headers: streamHeaders(anchor.stream), time, width, height, timeoutMs });
    } catch {
      continue;
    }
    const anchorMetrics = frameMetrics(anchorFrame, width, height);
    scores.get(anchor.provider).push(0);
    similarities.get(anchor.provider).push(1);

    await Promise.all(candidates.filter(entry => entry !== anchor).map(async entry => {
      try {
        const frame = await extractGrayFrame(entry.stream.url, { headers: streamHeaders(entry.stream), time, width, height, timeoutMs });
        const similarity = frameSimilarity(anchorFrame, frame);
        similarities.get(entry.provider).push(similarity);
        if (similarity < similarityThreshold) return;
        scores.get(entry.provider).push(relativeScore(frameMetrics(frame, width, height), anchorMetrics));
      } catch {}
    }));
  }

  const providerResults = candidates.map(entry => {
    const values = scores.get(entry.provider) || [];
    const sims = similarities.get(entry.provider) || [];
    return {
      provider: entry.provider,
      samples: values.length,
      score: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
      minSimilarity: sims.length ? Math.min(...sims) : null
    };
  }).filter(item => item.score != null).sort((a, b) => b.score - a.score);

  if (providerResults.length < 2) return { available: false, confidence: 'none', reason: 'frames-not-aligned', providers: providerResults };
  const best = providerResults[0], second = providerResults[1];
  const margin = best.score - second.score;
  const bestSamples = scores.get(best.provider) || [];
  const secondSamples = scores.get(second.provider) || [];
  const comparableCount = Math.min(bestSamples.length, secondSamples.length);
  const pairMargins = Array.from({ length: comparableCount }, (_, index) => bestSamples[index] - secondSamples[index]);
  const consistent = pairMargins.length >= 2 && pairMargins.every(value => value >= 0.025);
  const high = comparableCount >= 2 && consistent && margin >= 0.055;
  const medium = comparableCount >= 1 && margin >= 0.035;
  return {
    available: true,
    confidence: high ? 'high' : medium ? 'medium' : 'low',
    reason: high ? 'consistent-visual-win' : medium ? 'possible-visual-win' : 'visual-difference-too-small',
    selectedProvider: best.provider,
    margin,
    times,
    providers: providerResults
  };
}

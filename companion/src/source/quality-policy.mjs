const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function codecEfficiencyFactor(codecs = '') {
  const value = String(codecs || '').toLowerCase();
  if (/av01|\bav1\b/.test(value)) return 1.35;
  if (/hev1|hvc1|hevc|h265|h\.265/.test(value)) return 1.25;
  if (/vp09|\bvp9\b/.test(value)) return 1.22;
  return 1;
}

export function qualityEvidence(probe = {}) {
  const quality = probe?.quality || {};
  const height = Number(quality.height || 0) || null;
  const width = Number(quality.width || 0) || (height ? Math.round(height * 16 / 9) : null);
  const bitrate = Number(quality.averageBandwidth || quality.bandwidth || 0) || null;
  const frameRate = Number(quality.frameRate || 0) || null;
  const codecFactor = codecEfficiencyFactor(quality.codecs || '');
  const effectiveBitrate = bitrate ? bitrate * codecFactor : null;
  const pixels = width && height ? width * height : null;
  const effectiveBitsPerPixelFrame = effectiveBitrate && pixels
    ? effectiveBitrate / pixels / (frameRate || 24)
    : null;
  return {
    width,
    height,
    bitrate,
    frameRate,
    codecs: String(quality.codecs || ''),
    codecFactor,
    effectiveBitrate,
    pixels,
    effectiveBitsPerPixelFrame
  };
}

export function resolutionRatio(aHeight, bHeight) {
  const a = Number(aHeight || 0), b = Number(bHeight || 0);
  if (!a || !b) return null;
  return Math.max(a, b) / Math.min(a, b);
}

export function visuallyComparableResolutions(aHeight, bHeight, maxRatio = 1.18) {
  const ratio = resolutionRatio(aHeight, bHeight);
  return ratio != null && ratio <= maxRatio;
}

export function clearResolutionAdvantage(bestProbe, currentProbe) {
  const best = qualityEvidence(bestProbe), current = qualityEvidence(currentProbe);
  if (!best.height || !current.height || best.height <= current.height) return false;
  const ratio = best.height / current.height;
  const difference = best.height - current.height;
  if (difference < 180 || ratio < 1.25) return false;

  if (best.effectiveBitrate && current.effectiveBitrate
      && best.effectiveBitrate < current.effectiveBitrate * 0.70) return false;
  return true;
}

export function decisiveBitrateQualityAdvantage(bestProbe, currentProbe) {
  const best = qualityEvidence(bestProbe), current = qualityEvidence(currentProbe);
  if (!best.height || !current.height || !best.effectiveBitrate || !current.effectiveBitrate) return false;
  const ratio = resolutionRatio(best.height, current.height);
  if (ratio == null || ratio > 1.18) return false;

  const bitrateRatio = best.effectiveBitrate / current.effectiveBitrate;
  // Same-resolution encodes need a clear bitrate/codec-efficiency gap. When the
  // nominal winner is modestly lower resolution (e.g. 720p vs 804p), demand a
  // larger gap so bitrate does not casually erase real spatial detail.
  if (best.height === current.height) return bitrateRatio >= 1.30;
  if (best.height < current.height) return bitrateRatio >= 1.55;
  return bitrateRatio >= 1.20;
}

export function compareProbeQuality(aProbe, bProbe) {
  const a = qualityEvidence(aProbe), b = qualityEvidence(bProbe);

  if (a.height && b.height) {
    if (clearResolutionAdvantage(aProbe, bProbe)) return -1;
    if (clearResolutionAdvantage(bProbe, aProbe)) return 1;

    const ratio = resolutionRatio(a.height, b.height);
    if (ratio != null && ratio <= 1.18) {
      if (a.effectiveBitrate && b.effectiveBitrate) {
        const bitrateRatio = a.effectiveBitrate / b.effectiveBitrate;
        if (bitrateRatio >= 1.15) return -1;
        if (bitrateRatio <= 1 / 1.15) return 1;
      }
      if (a.height !== b.height) return b.height - a.height;
    } else if (a.height !== b.height) {
      return b.height - a.height;
    }
  }

  if (a.effectiveBitrate && b.effectiveBitrate) {
    const bitrateRatio = a.effectiveBitrate / b.effectiveBitrate;
    if (bitrateRatio >= 1.20) return -1;
    if (bitrateRatio <= 1 / 1.20) return 1;
  }

  if (a.height && !b.height) return -1;
  if (!a.height && b.height) return 1;
  return 0;
}

export function descriptiveQualityScore(probe = {}) {
  const evidence = qualityEvidence(probe);
  const resolution = evidence.height ? Math.log2(Math.max(1, evidence.height / 360)) * 10_000 : 0;
  const bitrateMbps = evidence.effectiveBitrate ? evidence.effectiveBitrate / 1_000_000 : 0;
  const bitrate = bitrateMbps ? Math.log2(1 + bitrateMbps) * 2_500 : 0;
  return Math.round(clamp(resolution + bitrate, 0, 100_000));
}

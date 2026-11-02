const EARLY_REASONS = new Set(['clear-resolution-win', 'decisive-bitrate-quality-win']);

export function allowQuickAutoSwitch(scan, safety, { minWinnerStability = 90 } = {}) {
  if (!safety?.switch || !EARLY_REASONS.has(String(safety.reason || ''))) return false;
  const selectedProvider = safety.selected?.provider;
  if (!selectedProvider) return false;
  const ranked = scan?.decision?.ranked || [];
  const winner = ranked.find(item => item?.ok && item?.value?.provider === selectedProvider);
  const stability = Number(winner?.value?.probe?.metrics?.stability || 0);
  return Boolean(winner?.stable) && stability >= minWinnerStability;
}

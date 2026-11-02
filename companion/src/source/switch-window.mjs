export function withinSourceSwitchWindow(entryStartedAt, {
  now = Date.now(),
  maxSeconds = 120
} = {}) {
  const started = Number(entryStartedAt || 0);
  if (!started) return false;
  const elapsed = Math.max(0, Number(now) - started);
  return elapsed <= Math.max(1, Number(maxSeconds) || 120) * 1000;
}

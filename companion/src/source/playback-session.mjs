// For an in-flight scan, the playback identity includes the renderer session
// and selected provider. A new entry is not a "manual override" and should be
// diagnosed normally; a scan from the prior entry cannot act on it.
export function sourcePlaybackSessionKey(episodeKey, context) {
  if (!episodeKey || context?.activePlayer !== true) return '';
  const entry = Number(context?.playbackSessionId || 0);
  const provider = String(context?.episode?.provider || '');
  if (!provider) return '';
  return episodeKey + '|entry:' + (Number.isSafeInteger(entry) && entry >= 0 ? entry : 0) +
    '|provider:' + provider;
}

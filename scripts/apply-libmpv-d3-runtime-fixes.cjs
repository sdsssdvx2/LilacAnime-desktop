'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const file = relative => path.join(root, relative);
const read = relative => fs.readFileSync(file(relative), 'utf8');
const write = (relative, value) => fs.writeFileSync(file(relative), value);

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one anchor, found ${count}`);
  return source.replace(needle, replacement);
}

// 1) Make sizing resilient even if a future CSS regression collapses the host.
let entry = read('src/libmpv-shared-entry.js');
entry = replaceOnce(
  entry,
  `  _surfaceSize() {\n    const rect = this.getBoundingClientRect();\n    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);\n    return {\n      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),\n      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160)\n    };\n  }`,
  `  _surfaceSize() {\n    const ownRect = this.getBoundingClientRect();\n    const stageRect = this.closest('#videoStage')?.getBoundingClientRect?.();\n    const rect = ownRect.width >= 2 && ownRect.height >= 2\n      ? ownRect\n      : (stageRect && stageRect.width >= 2 && stageRect.height >= 2 ? stageRect : { width: window.innerWidth, height: window.innerHeight });\n    const dpr = Math.max(1, Number(window.devicePixelRatio) || 1);\n    return {\n      width: clamp(Math.round(Math.max(2, rect.width) * dpr), 2, 3840),\n      height: clamp(Math.round(Math.max(2, rect.height) * dpr), 2, 2160)\n    };\n  }`,
  'surface size fallback'
);
entry = replaceOnce(
  entry,
  `      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);\n      await this._command(['set_property', 'volume', (this._muted ? 0 : this._volume) * 100]);`,
  `      if (result?.playerId) this.dataset.libmpvPlayerId = String(result.playerId);\n      // Explicitly recover automatic audio selection. This is a no-op when the\n      // source genuinely contains no audio track, but avoids carrying an aid=no\n      // state across player reuse or unusual demuxer initialization.\n      await this._command(['set_property', 'aid', 'auto']);\n      await this._command(['set_property', 'volume', (this._muted ? 0 : this._volume) * 100]);`,
  'audio auto recovery'
);

// Enrich renderer diagnostics without exposing media URLs or headers.
entry = replaceOnce(
  entry,
  `    const rect = host?.getBoundingClientRect?.();\n    return {\n      diagnosticVersion: VERSION,`,
  `    const rect = host?.getBoundingClientRect?.();\n    const stageRect = document.querySelector('#videoStage')?.getBoundingClientRect?.();\n    const style = host ? getComputedStyle(host) : null;\n    const targetSize = host && typeof host._surfaceSize === 'function' ? host._surfaceSize() : null;\n    return {\n      diagnosticVersion: VERSION,\n      runtimeRevision: 'SURFACE-AUDIO-R1',`,
  'renderer diagnostic revision'
);
entry = replaceOnce(
  entry,
  `      surface: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,\n      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,`,
  `      surface: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,\n      videoStage: stageRect ? { x: Math.round(stageRect.x), y: Math.round(stageRect.y), width: Math.round(stageRect.width), height: Math.round(stageRect.height) } : null,\n      surfaceStyle: style ? { display: style.display, position: style.position, width: style.width, height: style.height } : null,\n      requestedSurface: targetSize ? { width: Number(targetSize.width) || 0, height: Number(targetSize.height) || 0 } : null,\n      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,`,
  'renderer layout diagnostics'
);
write('src/libmpv-shared-entry.js', entry);

// 2) Add safe upstream HLS/TS audio evidence to the relay. Only counts and
// MPEG-TS stream-type identifiers are reported; never URLs, headers or tokens.
let relay = read('electron/mpv-relay.cjs');
relay = replaceOnce(
  relay,
  `    upstreamBytes: 0,\n    lastStatus: 0\n  };`,
  `    upstreamBytes: 0,\n    lastStatus: 0,\n    playlistAudioMediaTags: 0,\n    playlistVariantLines: 0,\n    playlistAudioCodecHints: 0,\n    tsPacketsSampled: 0\n  };\n  const tsStreamTypes = new Set();\n  const tsAudioStreamTypes = new Set();\n  const tsVideoStreamTypes = new Set();`,
  'relay audio counters'
);
relay = replaceOnce(
  relay,
  `    counters.upstreamBytes = 0;\n    counters.lastStatus = 0;`,
  `    counters.upstreamBytes = 0;\n    counters.lastStatus = 0;\n    counters.playlistAudioMediaTags = 0;\n    counters.playlistVariantLines = 0;\n    counters.playlistAudioCodecHints = 0;\n    counters.tsPacketsSampled = 0;\n    tsStreamTypes.clear();\n    tsAudioStreamTypes.clear();\n    tsVideoStreamTypes.clear();`,
  'relay audio counter reset'
);
relay = replaceOnce(
  relay,
  `      lastStatus: counters.lastStatus,\n      registeredResources: resources.size,`,
  `      lastStatus: counters.lastStatus,\n      playlistAudioMediaTags: counters.playlistAudioMediaTags,\n      playlistVariantLines: counters.playlistVariantLines,\n      playlistAudioCodecHints: counters.playlistAudioCodecHints,\n      tsPacketsSampled: counters.tsPacketsSampled,\n      tsStreamTypes: [...tsStreamTypes].sort(),\n      tsAudioStreamTypes: [...tsAudioStreamTypes].sort(),\n      tsVideoStreamTypes: [...tsVideoStreamTypes].sort(),\n      tsAudioDetected: tsAudioStreamTypes.size > 0,\n      tsVideoDetected: tsVideoStreamTypes.size > 0,\n      registeredResources: resources.size,`,
  'relay audio snapshot'
);
relay = replaceOnce(
  relay,
  `  function rewritePlaylist(text, sourceUrl, headers) {\n    return text.split(/\\r?\\n/).map(line => {`,
  `  function inspectPlaylist(text) {\n    const source = String(text || '');\n    counters.playlistAudioMediaTags += (source.match(/^#EXT-X-MEDIA:.*TYPE=AUDIO\\b/gmi) || []).length;\n    counters.playlistVariantLines += (source.match(/^#EXT-X-STREAM-INF:/gmi) || []).length;\n    counters.playlistAudioCodecHints += (source.match(/CODECS=\\"[^\\"]*(?:mp4a|aac|ac-3|ec-3|opus)[^\\"]*\\"/gi) || []).length;\n  }\n\n  function inspectTsPrograms(buffer) {\n    if (!Buffer.isBuffer(buffer) || buffer.length < 564) return;\n    let start = -1;\n    const scanLimit = Math.min(buffer.length - 376, 64 * 1024);\n    for (let offset = 0; offset <= scanLimit; offset++) {\n      if (buffer[offset] === 0x47 && buffer[offset + 188] === 0x47 && buffer[offset + 376] === 0x47) {\n        start = offset;\n        break;\n      }\n    }\n    if (start < 0) return;\n\n    const pmtPids = new Set();\n    const audioTypes = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);\n    const videoTypes = new Set([0x01, 0x02, 0x10, 0x1b, 0x24, 0x42]);\n    const end = Math.min(buffer.length, start + 188 * 2048);\n    let sampled = 0;\n\n    for (let offset = start; offset + 188 <= end; offset += 188) {\n      if (buffer[offset] !== 0x47) break;\n      sampled++;\n      const pusi = Boolean(buffer[offset + 1] & 0x40);\n      const pid = ((buffer[offset + 1] & 0x1f) << 8) | buffer[offset + 2];\n      const adaptation = (buffer[offset + 3] >> 4) & 0x03;\n      if (adaptation === 0 || adaptation === 2) continue;\n      let pos = offset + 4;\n      if (adaptation === 3) pos += 1 + (buffer[pos] || 0);\n      if (pos >= offset + 188) continue;\n      if (pusi) pos += 1 + (buffer[pos] || 0);\n      if (pos + 3 > offset + 188) continue;\n\n      if (pid === 0 && buffer[pos] === 0x00) {\n        const sectionLength = ((buffer[pos + 1] & 0x0f) << 8) | buffer[pos + 2];\n        const sectionEnd = Math.min(offset + 188, pos + 3 + sectionLength - 4);\n        for (let p = pos + 8; p + 4 <= sectionEnd; p += 4) {\n          const program = (buffer[p] << 8) | buffer[p + 1];\n          if (!program) continue;\n          pmtPids.add(((buffer[p + 2] & 0x1f) << 8) | buffer[p + 3]);\n        }\n        continue;\n      }\n\n      if (pmtPids.has(pid) && buffer[pos] === 0x02) {\n        const sectionLength = ((buffer[pos + 1] & 0x0f) << 8) | buffer[pos + 2];\n        const sectionEnd = Math.min(offset + 188, pos + 3 + sectionLength - 4);\n        if (pos + 12 > sectionEnd) continue;\n        const programInfoLength = ((buffer[pos + 10] & 0x0f) << 8) | buffer[pos + 11];\n        let p = pos + 12 + programInfoLength;\n        while (p + 5 <= sectionEnd) {\n          const streamType = buffer[p];\n          const label = '0x' + streamType.toString(16).padStart(2, '0');\n          tsStreamTypes.add(label);\n          if (audioTypes.has(streamType)) tsAudioStreamTypes.add(label);\n          if (videoTypes.has(streamType)) tsVideoStreamTypes.add(label);\n          const esInfoLength = ((buffer[p + 3] & 0x0f) << 8) | buffer[p + 4];\n          p += 5 + esInfoLength;\n        }\n      }\n    }\n    counters.tsPacketsSampled += sampled;\n  }\n\n  function rewritePlaylist(text, sourceUrl, headers) {\n    inspectPlaylist(text);\n    return text.split(/\\r?\\n/).map(line => {`,
  'relay safe playlist/TS inspection'
);
relay = replaceOnce(
  relay,
  `        const normalized = stripPngTsWrapper(raw);\n        if (normalized.stripped) counters.strippedSegments++;`,
  `        const normalized = stripPngTsWrapper(raw);\n        if (normalized.stripped) counters.strippedSegments++;\n        inspectTsPrograms(normalized.buffer);`,
  'relay TS inspection call'
);
write('electron/mpv-relay.cjs', relay);

// 3) Mark the diagnostic payload so this runtime can be distinguished from the
// first D2 installer without changing the version string used by existing gates.
let bridge = read('electron/libmpv-shared-main.cjs');
bridge = replaceOnce(
  bridge,
  `      diagnosticVersion: 'LIBMPV-SHARED-D2',\n      ...state(),`,
  `      diagnosticVersion: 'LIBMPV-SHARED-D2',\n      runtimeRevision: 'SURFACE-AUDIO-R1',\n      ...state(),`,
  'main diagnostic revision'
);
write('electron/libmpv-shared-main.cjs', bridge);

for (const [relative, markers] of [
  ['src/libmpv-shared-entry.js', ['SURFACE-AUDIO-R1', "['set_property', 'aid', 'auto']", "this.closest('#videoStage')"]],
  ['electron/mpv-relay.cjs', ['tsAudioDetected', 'playlistAudioMediaTags', 'inspectTsPrograms']],
  ['electron/libmpv-shared-main.cjs', ["runtimeRevision: 'SURFACE-AUDIO-R1'"]]
]) {
  const source = read(relative);
  for (const marker of markers) if (!source.includes(marker)) throw new Error(`${relative} missing ${marker}`);
}

console.log('LIBMPV_D3_RUNTIME_FIXES_OK');

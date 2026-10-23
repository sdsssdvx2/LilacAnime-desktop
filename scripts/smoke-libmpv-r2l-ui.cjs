'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const entry = read('src/libmpv-shared-entry.js');
const player = read('src/player.js');
const app = read('src/app.js');
const pkg = JSON.parse(read('package.json'));

const checks = {
  generationBound: entry.includes('Number(state.generation) !== this._generation'),
  endedEdge: entry.includes("this._ended && !previousEnded"),
  episodeLock: player.includes('let episodeTransitioning = false') && player.includes('if (!episode || episodeTransitioning) return') && player.includes('unlockedPlaySiblingEpisode'),
  pausedAutoHide: app.includes("if(!settingsOpen())controlsTimer=setTimeout") && !app.includes("if(!$('#video').paused&&!settingsOpen())"),
  mouseReveal: player.includes('if (!playerLocked) showPlayerControls();'),
  keyboardReveal: player.includes('typingTarget') && player.includes("document.body.classList.contains('player-mode')") && player.includes('!event.ctrlKey && !event.altKey && !event.metaKey') && player.includes('showPlayerControls();'),
  pipHidden: player.includes("tagName === 'LILAC-MPV-VIDEO'") && player.includes("$('#miniPlayer').classList.add('hidden')"),
  subtitleDirectPosition: entry.includes('position.toFixed(3)') && !entry.includes('bottomInset.toFixed(3)'),
  subtitleMetrics: entry.includes('line-height:1.2') && !entry.includes('gap:.08em'),
  inPlaceIdentity: pkg.build?.appId === 'com.lilac.anime.desktop.libmpvr2kcandidate' && pkg.build?.productName === 'LilacAnime Libmpv R2K 0.5.49',
  customTag: pkg.lilacCustomTag === 'libmpv-r2k-v0.5.49-r2',
  version: pkg.version === '0.5.49-libmpv-r2l.rc1'
};
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length) {
  console.error(`LIBMPV_R2L_UI_FAIL ${failed.join(',')}`);
  console.error(JSON.stringify(checks));
  process.exit(1);
}
console.log('LIBMPV_R2L_UI_PASS generation=bound ended=edge episode=locked controls=transient mouse=1 keyboard=1 pip=hidden subtitles=calibrated identity=in-place');

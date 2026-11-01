'use strict';

const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { R40SubtitleOverlayWindowController } = require('../electron/r40-subtitle-overlay-window.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(fn, timeout, label) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch (error) { last = error; }
    await sleep(25);
  }
  throw new Error(`${label} timeout last=${last && last.message ? last.message : JSON.stringify(last)}`);
}

(async () => {
  let owner, rival, controller;
  try {
    await app.whenReady();
    owner = new BrowserWindow({ show:false, width:960, height:540, webPreferences:{backgroundThrottling:false} });
    await owner.loadURL('data:text/html,<html><body style="margin:0;background:#223344"></body></html>');
    owner.show(); owner.focus();
    await waitUntil(() => owner.isFocused(), 3000, 'owner focus');

    controller = new R40SubtitleOverlayWindowController({ BrowserWindow, baseDir:path.resolve(__dirname, '..', 'electron') });
    rival = new BrowserWindow({ show:false, width:320, height:220, x:1000, y:80, webPreferences:{backgroundThrottling:false} });
    await rival.loadURL('data:text/html,<html><body style="margin:0;background:#207040"></body></html>');
    rival.show(); rival.focus();
    await waitUntil(() => !owner.isFocused() && rival.isFocused(), 3000, 'owner blur');

    const payload = {
      revision: 44, active:true,
      stackRect:{x:180,y:390,width:600,height:90},
      stackStyle:{position:'absolute',display:'flex',color:'rgb(255,0,255)',fontSize:'36px'},
      stackGap:'0px', stackAlignItems:'center', stackJustifyContent:'center',
      cues:[{html:'R44 race',style:{color:'rgb(255,0,255)',fontSize:'36px'}}]
    };

    // Deliberately start both operations without awaiting either one. Before R44,
    // the second ensure() could observe window!=null and return it before loadFile
    // completed. R44 must serialize both callers on the same ensurePromise.
    const prewarmPromise = controller.prewarm(owner, 'r44-concurrent-smoke');
    const activePromise = controller.update(owner, payload);
    const [prewarmResult, activeResult] = await Promise.all([prewarmPromise, activePromise]);
    const state = controller.snapshot();
    const win = controller.window;
    if (!prewarmResult?.ok || !activeResult?.ok) throw new Error(`R44 concurrent operation failed prewarm=${JSON.stringify(prewarmResult)} active=${JSON.stringify(activeResult)}`);
    if (!win || win.isDestroyed() || !state.ready || state.windowVisible !== true || state.active !== true) throw new Error(`R44 concurrent final state invalid ${JSON.stringify(state)}`);
    if (state.showCount !== 1 || state.prewarmShows !== 1) throw new Error(`R44 concurrent ensure created/re-shown multiple HWNDs ${JSON.stringify(state)}`);
    if (state.failures !== 0 || state.revealPending !== false) throw new Error(`R44 concurrent ensure failure/pending reveal ${JSON.stringify(state)}`);
    if (state.firstActiveSessionReanchors !== 1 || state.sessionNeedsActiveReanchor !== false) throw new Error(`R44 concurrent first-active z-order guard did not complete ${JSON.stringify(state)}`);
    const kinds = state.transitionTrace.map(event => event.kind);
    for (const kind of ['load-ready','prewarm-show-opacity-zero','first-active-session-reanchor-opacity-zero','reveal-visible-reanchored']) {
      if (!kinds.includes(kind)) throw new Error(`R44 transition trace missing ${kind}: ${JSON.stringify(kinds)}`);
    }
    const domActive = await win.webContents.executeJavaScript("document.body.dataset.active==='1' && document.body.dataset.revision==='44'");
    if (!domActive) throw new Error(`R44 concurrent active DOM not committed ${JSON.stringify(state)}`);

    console.log(`R44_CONCURRENT_OVERLAY_ENSURE_OK showCount=${state.showCount} prewarmShows=${state.prewarmShows} firstActiveReanchors=${state.firstActiveSessionReanchors} failures=${state.failures}`);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    try { controller?.destroy('smoke-done'); } catch {}
    try { if (rival && !rival.isDestroyed()) rival.destroy(); } catch {}
    try { if (owner && !owner.isDestroyed()) owner.destroy(); } catch {}
    setTimeout(() => app.quit(), 50);
  }
})();

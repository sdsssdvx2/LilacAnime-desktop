'use strict';
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const { VIDEO_ASPECT_RATIO, isVideoAspectLocked, setVideoAspectLocked } = require('../electron/window-aspect.cjs');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, width: 960, height: 540, webPreferences: { sandbox: true } });
  assert.equal(typeof win.setAspectRatio, 'function');
  const locked = setVideoAspectLocked(win, true);
  assert.equal(locked.applied, true);
  assert.ok(Math.abs(locked.ratio - VIDEO_ASPECT_RATIO) < 1e-9);
  assert.equal(isVideoAspectLocked(win), true);
  // Electron documents that programmatic setSize/setBounds ignore aspect-ratio constraints;
  // this proves our native lock does not interfere with existing mini-player restore bounds.
  win.setSize(1000, 700);
  assert.deepEqual(win.getSize(), [1000, 700]);
  const unlocked = setVideoAspectLocked(win, false);
  assert.equal(unlocked.ratio, 0);
  assert.equal(isVideoAspectLocked(win), false);
  win.destroy();
  console.log('LIBMPV_R2W_WINDOW_ASPECT_RUNTIME_OK');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });

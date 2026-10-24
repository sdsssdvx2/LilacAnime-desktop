'use strict';

const VIDEO_ASPECT_RATIO = 16 / 9;

function usableWindow(win) {
  return Boolean(win && !win.isDestroyed?.());
}

function isVideoAspectLocked(win) {
  return Boolean(usableWindow(win) && win.__lilacVideoAspectLocked === true);
}

function setVideoAspectLocked(win, enabled) {
  const locked = Boolean(enabled);
  if (!usableWindow(win)) return { locked: false, applied: false, ratio: 0 };
  win.__lilacVideoAspectLocked = locked;
  let applied = false;
  if (typeof win.setAspectRatio === 'function') {
    win.setAspectRatio(locked ? VIDEO_ASPECT_RATIO : 0);
    applied = true;
  }
  return { locked, applied, ratio: locked ? VIDEO_ASPECT_RATIO : 0 };
}

module.exports = { VIDEO_ASPECT_RATIO, isVideoAspectLocked, setVideoAspectLocked };

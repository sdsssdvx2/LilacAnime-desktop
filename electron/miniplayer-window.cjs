'use strict';

const waitForWindowEvent = (win, event, timeout = 800) => new Promise(resolve => {
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    win.removeListener?.(event, done);
    resolve();
  };
  const timer = setTimeout(done, timeout);
  win.once?.(event, done);
});

class MiniPlayerWindowController {
  constructor({ screen, margin = 16, maxWidth = 640 } = {}) {
    if (!screen) throw new Error('screen is required');
    this.screen = screen;
    this.margin = margin;
    this.maxWidth = maxWidth;
    this.states = new WeakMap();
  }

  active(win) { return Boolean(win && this.states.has(win)); }

  async set(win, enabled) {
    if (!win || win.isDestroyed?.()) return { active: false };
    return enabled ? this.enter(win) : this.leave(win);
  }

  async enter(win) {
    if (this.states.has(win)) return { active: true, bounds: win.getBounds?.() };
    const bounds = win.getNormalBounds?.() || win.getBounds();
    const state = {
      bounds: { ...bounds },
      maximized: Boolean(win.isMaximized?.()),
      fullScreen: Boolean(win.isFullScreen?.()),
      alwaysOnTop: Boolean(win.isAlwaysOnTop?.()),
      minimumSize: win.getMinimumSize?.() || [0, 0],
      resizable: win.isResizable?.() !== false
    };
    this.states.set(win, state);
    win.__lilacMiniPlayer = true;

    if (win.isFullScreen?.()) {
      const left = waitForWindowEvent(win, 'leave-full-screen');
      win.setFullScreen(false);
      await left;
    }
    if (win.isMaximized?.()) win.unmaximize();

    win.setMinimumSize?.(320, 180);
    win.setResizable?.(true);
    const display = this.screen.getDisplayMatching(state.bounds) || this.screen.getPrimaryDisplay();
    const area = display.workArea;
    let width = Math.min(this.maxWidth, Math.max(480, Math.floor(area.width * 0.36)));
    let height = Math.round(width * 9 / 16);
    if (height > area.height - this.margin * 2) {
      height = Math.max(180, area.height - this.margin * 2);
      width = Math.round(height * 16 / 9);
    }
    const next = {
      x: area.x + area.width - width - this.margin,
      y: area.y + area.height - height - this.margin,
      width,
      height
    };
    win.setAlwaysOnTop?.(true, 'floating');
    win.setBounds?.(next, true);
    win.show?.();
    win.focus?.();
    return { active: true, bounds: next };
  }

  async leave(win) {
    const state = this.states.get(win);
    if (!state) return { active: false };
    this.states.delete(win);
    win.__lilacMiniPlayer = false;
    if (win.isDestroyed?.()) return { active: false };

    win.setAlwaysOnTop?.(state.alwaysOnTop);
    win.setMinimumSize?.(...state.minimumSize);
    win.setResizable?.(state.resizable);
    if (win.isFullScreen?.()) {
      const left = waitForWindowEvent(win, 'leave-full-screen');
      win.setFullScreen(false);
      await left;
    }
    if (win.isMaximized?.()) win.unmaximize();
    win.setBounds?.(state.bounds, true);
    if (state.maximized) win.maximize?.();
    if (state.fullScreen) {
      const entered = waitForWindowEvent(win, 'enter-full-screen');
      win.setFullScreen(true);
      await entered;
    }
    return { active: false, bounds: state.bounds };
  }
}

module.exports = { MiniPlayerWindowController };

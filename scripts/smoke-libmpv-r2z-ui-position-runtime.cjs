'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.resolve(__dirname, '..');
const css = [
  fs.readFileSync(path.join(root, 'src/player-port.css'), 'utf8'),
  fs.readFileSync(path.join(root, 'src/player-android.css'), 'utf8')
].join('\n');

function closeTo(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got=${actual} expected=${expected} tolerance=${tolerance}`);
}

(async () => {
  await app.whenReady();
  const win = new BrowserWindow({
    show: false,
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  try {
    const html = `<!doctype html><meta charset="utf-8"><style>${css}</style>
      <div id="player" class="immersive-player controls-visible windowed">
        <div class="player-top">
          <button id="back">B</button>
          <div class="player-heading"><h1>Title</h1><p>11화</p></div>
          <div id="status" class="player-status">OP/ED 구간을 찾지 못했습니다.</div>
          <button id="gear" class="player-icon">G</button>
        </div>
        <div id="settings" class="player-settings open"><div style="height:500px">settings</div></div>
      </div>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    const samples = await win.webContents.executeJavaScript(`(()=>{
      const player=document.querySelector('#player');
      const read=()=>{
        const gear=document.querySelector('#gear').getBoundingClientRect();
        const status=document.querySelector('#status').getBoundingClientRect();
        const settings=document.querySelector('#settings').getBoundingClientRect();
        return {
          gear:{left:gear.left,right:gear.right,top:gear.top},
          status:{left:status.left,right:status.right,top:status.top},
          settings:{left:settings.left,right:settings.right,top:settings.top,width:settings.width},
          viewport:{width:innerWidth,height:innerHeight},
          windowed:player.classList.contains('windowed')
        };
      };
      const out=[];
      for(let i=0;i<8;i+=1){
        player.classList.toggle('windowed',i%2===0);
        void player.offsetWidth;
        out.push(read());
      }
      return out;
    })()`);

    assert.equal(samples.length, 8);
    const base = samples[0];
    for (const [index, sample] of samples.entries()) {
      for (const key of ['left', 'right', 'top']) {
        closeTo(sample.gear[key], base.gear[key], 0.25, `gear ${key} toggle=${index}`);
        closeTo(sample.status[key], base.status[key], 0.25, `status ${key} toggle=${index}`);
      }
      for (const key of ['left', 'right', 'top', 'width']) {
        closeTo(sample.settings[key], base.settings[key], 0.25, `settings ${key} toggle=${index}`);
      }
      closeTo(sample.viewport.width - sample.gear.right, 28, 0.25, `gear right margin toggle=${index}`);
      closeTo(sample.viewport.width - sample.settings.right, 16, 0.25, `settings right margin toggle=${index}`);
    }

    console.log(`LIBMPV_R2Z_UI_POSITION_RUNTIME_OK ${JSON.stringify({gearRightMargin:base.viewport.width-base.gear.right,settingsRightMargin:base.viewport.width-base.settings.right,statusRight:base.status.right,toggles:samples.length})}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    app.quit();
  }
})().catch(error => {
  console.error(error?.stack || error);
  app.exit(1);
});

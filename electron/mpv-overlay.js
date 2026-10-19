const $ = selector => document.querySelector(selector);
const fmt = value => {
  const seconds = Math.max(0, Number(value) || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
};

let lastState = null;
let lastReport = null;
let seeking = false;
let controlsTimer = null;
let lastMetaAt = 0;

function showControls() {
  document.body.classList.add('show-controls');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    if (!document.body.classList.contains('diag-open')) document.body.classList.remove('show-controls');
  }, 2300);
}

window.addEventListener('mousemove', showControls, { passive: true });
window.addEventListener('mousedown', showControls, { passive: true });

async function command(command) {
  const result = await window.mpvOverlay.command(command).catch(() => null);
  return Boolean(result?.ok);
}

async function refreshMeta() {
  const now = Date.now();
  if (now - lastMetaAt < 1000) return;
  lastMetaAt = now;
  const meta = await window.mpvOverlay.meta().catch(() => null);
  if (!meta) return;
  if (meta.title) $('#title').textContent = meta.title;
  if (meta.meta) $('#meta').textContent = meta.meta;
}

async function refresh() {
  const state = await window.mpvOverlay.state().catch(() => null);
  if (!state?.active) return;
  lastState = state;
  const duration = Math.max(0, Number(state.duration) || 0);
  const time = Math.max(0, Number(state.time) || 0);
  if (!seeking) {
    $('#seek').max = String(duration || 1);
    $('#seek').value = String(Math.min(time, duration || time || 0));
  }
  $('#time').textContent = `${fmt(time)} / ${fmt(duration)}`;
  $('#play').textContent = state.paused ? '▶' : 'Ⅱ';
  $('#volume').value = String(Math.round(Number(state.volume ?? 100)));
  $('#status').textContent = `mpv · ${state.width || 0}×${state.height || 0} · ${state.fps ? Number(state.fps).toFixed(2) + 'fps' : '-'} · ${state.paused ? 'paused' : 'playing'}`;
  void refreshMeta();
}

$('#back').onclick = async () => { await window.mpvOverlay.action('back').catch(() => null); };
$('#settings').onclick = async () => { await window.mpvOverlay.action('settings').catch(() => null); };
$('#play').onclick = async () => { if (!lastState) return; await command(['set_property','pause',!Boolean(lastState.paused)]); await refresh(); };
$('#back10').onclick = async () => { if (!lastState) return; await command(['seek',-10,'relative+exact']); await refresh(); };
$('#forward10').onclick = async () => { if (!lastState) return; await command(['seek',10,'relative+exact']); await refresh(); };
$('#mute').onclick = async () => { if (!lastState) return; const muted = Boolean(lastState.muted); await command(['set_property','mute',!muted]); };
$('#volume').oninput = async event => { await command(['set_property','volume',Number(event.target.value)]); };
$('#seek').onpointerdown = () => { seeking = true; };
$('#seek').oninput = event => { $('#time').textContent = `${fmt(event.target.value)} / ${fmt(lastState?.duration)}`; };
$('#seek').onchange = async event => { await command(['set_property','time-pos',Number(event.target.value)]); seeking = false; await refresh(); };
$('#seek').onpointerup = () => { seeking = false; };

function applySubtitle(payload) {
  const box = $('#subtitle');
  const text = String(payload?.text || '');
  box.textContent = text;
  box.style.display = text ? 'block' : 'none';
  const style = payload?.style || {};
  const size = Math.max(60, Math.min(180, Number(style.size) || 100));
  const position = Math.max(3, Math.min(45, Number(style.position) || 12));
  const outline = Math.max(0, Math.min(6, Number(style.outline) || 2));
  box.style.fontSize = `${Math.round(34 * size / 100)}px`;
  box.style.bottom = `${position}%`;
  box.style.fontWeight = style.bold === false ? '500' : '700';
  const shadow = [];
  const o = Math.max(1, outline);
  for (const [x,y] of [[-o,-o],[o,-o],[-o,o],[o,o],[0,o+1]]) shadow.push(`${x}px ${y}px 0 #000`);
  box.style.textShadow = shadow.join(',');
}

function showReport(report) {
  lastReport = report || null;
  $('#diagText').value = JSON.stringify(report || {}, null, 2);
  document.body.classList.add('diag-open','show-controls');
}

$('#diagButton').onclick = async () => {
  if (lastReport) return showReport(lastReport);
  const report = await window.mpvOverlay.diagnostics().catch(error => ({ overlayError: String(error?.message || error) }));
  showReport(report);
};
$('#closeDiag').onclick = () => { document.body.classList.remove('diag-open'); showControls(); };
$('#copyDiag').onclick = async () => {
  const value = $('#diagText').value;
  try { await navigator.clipboard.writeText(value); $('#copyDiag').textContent = '복사됨'; }
  catch { $('#diagText').focus(); $('#diagText').select(); document.execCommand('copy'); $('#copyDiag').textContent = '복사됨'; }
};

window.mpvOverlay.onSubtitle(applySubtitle);
window.mpvOverlay.onReport(showReport);
window.mpvOverlay.onReset(() => {
  lastState = null;
  lastReport = null;
  applySubtitle({ text: '' });
  $('#status').textContent = 'overlay idle';
});

setInterval(() => void refresh(), 250);
void refresh();
showControls();

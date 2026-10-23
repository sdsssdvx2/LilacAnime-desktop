// Whisper AI 자막 (Android playbackAiMode "whisper"): the episode's Japanese speech recognized on this PC (electron/whisper.cjs)
// when it has no subtitle to show or translate. The lines appear as they are recognized (the part from where it is
// playing comes first); the finished subtitle is saved with the episode and, when a translation side is set up,
// translated into Korean by the existing translation (자막 자동 번역).
// Loaded after app.js and player.js and shares their globals.
let whisperState = null, whisperRunId = 0;
const whisperAuto = () => localStorage.getItem('whisperAuto') === 'true';

// The settings pane: the runtime, the models and the automatic switch.
const whisperModelProgress = {};
let whisperInstallMessage = '';
async function renderWhisperSettings(value) {
  value ||= await window.lilac.whisperStatus().catch(() => null); if (!value || !$('#whisperModelList')) return;
  whisperState = value;
  $('#whisperRuntimeState').textContent = value.installing ? (whisperInstallMessage || '설치하는 중…') : value.runtime ? '설치됨 · 이 PC의 CPU로 음성을 인식합니다.' : '아직 설치하지 않았어요. 처음 한 번 Python과 whisper.cpp(약 100MB)를 받습니다.';
  const install = $('#whisperInstall'); install.classList.toggle('hidden', value.runtime); install.disabled = value.installing; install.textContent = value.installing ? '설치하는 중…' : '설치';
  $('#whisperModelList').replaceChildren(...value.models.map(model => {
    const row = document.createElement('div'), progress = whisperModelProgress[model.id], selected = model.installed && model.id === value.model;
    row.className = `local-model${selected ? ' selected' : ''}`;
    const state = selected ? '사용 중' : model.installed ? '받음 · 눌러서 사용' : progress != null ? '받는 중' : model.id === value.model ? '선택됨 · 받아야 써요' : '받지 않음';
    row.innerHTML = `<button type="button" class="local-model-pick"><b>${escapeHtml(model.label)}</b><small>${escapeHtml(model.note)}</small></button><span class="local-model-state">${state}</span><button type="button" class="local-model-action"></button>`;
    const pick = row.querySelector('.local-model-pick'), action = row.querySelector('.local-model-action');
    pick.disabled = selected; pick.onclick = async () => renderWhisperSettings(await window.lilac.whisperSelect(model.id));
    if (progress != null) { action.textContent = `받는 중 ${progress}%`; action.disabled = true; }
    else if (model.installed) { action.textContent = '삭제'; action.onclick = async () => { if (await askConfirm(`Whisper ${model.label} 모델을 삭제할까요?`, { ok: '삭제', danger: true })) renderWhisperSettings(await window.lilac.whisperRemove(model.id)); }; }
    else {
      action.textContent = model.partial ? `이어 받기 · ${Math.round(model.partial / model.size * 100)}% 받음` : `받기 · ${model.size >= 1e9 ? `${(model.size / 1e9).toFixed(1)}GB` : `${Math.round(model.size / 1e6)}MB`}`;
      action.onclick = () => downloadWhisperModel(model.id);
    }
    return row;
  }));
  $('#whisperAuto').checked = whisperAuto();
}
async function downloadWhisperModel(id) {
  whisperModelProgress[id] = 0; renderWhisperSettings(whisperState);
  try { await window.lilac.whisperSelect(id); await window.lilac.whisperDownload(id); toast('Whisper 모델을 받았어요.'); }
  catch (error) { toast(`Whisper 모델을 받지 못했습니다: ${ipcMessage(error)}`); }
  finally { delete whisperModelProgress[id]; renderWhisperSettings(); }
}
$('#whisperInstall').onclick = async () => {
  whisperInstallMessage = '설치를 시작하는 중…'; renderWhisperSettings({ ...(whisperState || {}), installing: true, models: whisperState?.models || [] });
  try { await window.lilac.whisperInstall(); toast('Whisper를 설치했어요.'); }
  catch (error) { toast(`Whisper를 설치하지 못했습니다: ${ipcMessage(error)}`); }
  finally { whisperInstallMessage = ''; renderWhisperSettings(); }
};
$('#whisperAuto').onchange = event => { localStorage.setItem('whisperAuto', String(event.target.checked)); };

// A run for the episode on screen: its lines are put on a live subtitle as they come.
let whisperRun = null;
const whisperRunning = () => whisperRun && whisperRun.requestId === playbackRequestId;
function whisperChip() { return $('#psSubtitleSources [data-source="whisper"] small'); }
function showWhisperProgress(text) {
  const chip = whisperChip(); if (chip) chip.textContent = text || '일본어 음성 → 번역';
  if (whisperRunning() && text) $('#subtitleState').textContent = `Whisper ${text}`;
}
// The recognized lines so far, as a subtitle on screen; later lines go into its track as cues.
function showWhisperLines(run, lines) {
  if (!lines.length || run !== whisperRun || !whisperRunning()) return;
  run.lines.push(...lines);
  const track = currentSubtitle?.whisperLive === run ? $('#video').textTracks[0] : null;
  if (track) { for (const line of lines) { try { track.addCue(new VTTCue(line.start, Math.max(line.end, line.start + 0.5), line.text)); } catch { /* a cue the browser refuses is left out */ } } return; }
  // Another subtitle on screen stays: one there when Whisper started by itself, or one picked since the lines went up.
  if (currentSubtitle && !currentSubtitle.whisperLive && (run.yielded || run.shown)) return;
  run.shown = true;
  const stamp = value => new Date(Math.max(0, value) * 1000).toISOString().slice(11, 23);
  const vtt = `WEBVTT\n\n${run.lines.map(line => `${stamp(line.start)} --> ${stamp(Math.max(line.end, line.start + 0.5))}\n${line.text}\n`).join('\n')}`;
  attachSubtitle(URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })), 'Whisper 일본어 자막 (인식 중)', { whisperLive: run, notice: 'Whisper가 인식한 일본어 대사를 띄웠어요. 인식이 끝나면 한국어로 번역해요.' });
}
window.lilac.onWhisperProgress(value => {
  if (value.kind === 'install') { whisperInstallMessage = `${value.message}${value.progress != null ? ` (${Math.round(value.progress * 100)}%)` : ''}`; if (whisperState) $('#whisperRuntimeState').textContent = whisperInstallMessage; return; }
  if (value.kind === 'model') { whisperModelProgress[value.id] = Math.round((value.progress || 0) * 100); if (whisperState) renderWhisperSettings(whisperState); return; }
  if (value.kind !== 'run' || value.id !== whisperRun?.id) return;
  if (value.lines) showWhisperLines(whisperRun, value.lines);
  if (Number.isFinite(value.done)) showWhisperProgress(value.duration > 0 ? `음성 인식 중 ${Math.min(99, Math.round(value.done / value.duration * 100))}%` : '음성 인식 중…');
});

// manual: the chip pressed (a second press stops a run). Returns whether a Whisper subtitle is on or on its way.
async function startWhisper(manual = false) {
  if (whisperRunning()) { if (manual) { window.lilac.whisperCancel(); toast('Whisper 음성 인식을 멈췄어요.'); } return true; }
  const key = subtitleStoreKey(), requestId = playbackRequestId, context = currentPlaybackContext;
  const status = await window.lilac.whisperStatus().catch(() => null);
  const model = status?.models.find(item => item.id === status.model);
  if (!status?.runtime || !model?.installed) {
    if (manual) { toast(!status?.runtime ? '설정 > Whisper AI 자막에서 먼저 설치해 주세요.' : `설정 > Whisper AI 자막에서 ${model?.label || ''} 모델을 먼저 받아 주세요.`); window.showSettingsPane?.('whisper'); }
    return false;
  }
  if (!key || !context.currentUrl) { if (manual) toast('재생 중인 영상이 없습니다.'); return false; }
  // The episode's saved Whisper subtitle (or its translation) is put on instead of recognizing it again.
  const saved = (await window.lilac.savedSubtitles(key).catch(() => [])).find(item => item.source === 'whisper');
  if (requestId !== playbackRequestId) return false;
  if (saved) { applySavedSubtitle(saved); translateWhisper(saved.path, manual); return true; }
  const run = whisperRun = { id: ++whisperRunId, requestId, key, lines: [], yielded: !manual && Boolean(currentSubtitle) };
  pressSubtitleSource('whisper'); renderSubtitleSheet(); showWhisperProgress('음성 인식 준비 중…');
  try {
    const result = await window.lilac.whisperTranscribe({ id: run.id, key, videoUrl: context.currentUrl, headers: context.streamHeaders || {}, startAt: $('#video').currentTime || 0, duration: playbackDuration() });
    if (result?.canceled || run !== whisperRun || requestId !== playbackRequestId) return true;
    if (!result.lines) { $('#subtitleState').textContent = 'Whisper가 이 회차에서 대사를 찾지 못했어요.'; return false; }
    // The finished file takes the live subtitle's place (or is only saved, when another subtitle was put on meanwhile).
    if (!currentSubtitle || currentSubtitle.whisperLive) { currentSubtitlePath = result.path; attachSubtitle(result.url, 'Whisper 일본어 자막', { path: result.path, source: 'whisper', notice: `Whisper가 대사 ${result.lines}줄을 인식했어요.` }); }
    else window.lilac.saveSubtitle(key, { source: 'whisper', label: 'Whisper 일본어 자막', path: result.path }).catch(() => {});
    translateWhisper(result.path, manual);
    return true;
  } catch (error) {
    if (run === whisperRun && requestId === playbackRequestId) { $('#subtitleState').textContent = 'Whisper 음성 인식에 실패했습니다.'; toast(`Whisper 실패: ${ipcMessage(error)}`); }
    return false;
  } finally { if (run === whisperRun) { whisperRun = null; showWhisperProgress(''); renderSubtitleSheet(); } }
}
// Into Korean with the side 자막 자동 번역 picks (or whichever is set up), as a Jimaku file is.
async function translateWhisper(path, manual) {
  translationSettings = await window.lilac.geminiSettings().catch(() => translationSettings);
  const provider = autoTranslateProvider() || (manual ? autoProvider() : null);
  if (!provider || currentSubtitle?.source !== 'whisper') return;
  runTranslation({ file: async () => ({ path }), name: 'Whisper', button: provider === 'local' ? $('#translateNowLocal') : $('#translateNow'), provider, manual });
}
// No subtitle anywhere and 자막이 없으면 자동으로 만들기 on.
async function whisperWhenNoSubtitle() { return whisperAuto() && startWhisper(false); }
document.querySelector('[data-settings-tab="whisper"]')?.addEventListener('click', () => renderWhisperSettings());
renderWhisperSettings();

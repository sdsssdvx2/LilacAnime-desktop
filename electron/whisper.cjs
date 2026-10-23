// Whisper AI 자막 (Android WhisperTranscriptionService): the episode's Japanese speech made into a subtitle by whisper.cpp,
// for the existing translation to turn into Korean. Runs in its own Python (pywhispercpp, a whisper.cpp build per
// platform: whisper.cpp gives no macOS program), installed once under userData/tools/whisper by uv, as ffsubsync is.
// The audio is read by FFmpeg and handed over as it comes, so the first lines are there within seconds; the part of
// the episode from where it is playing is done first, then the beginning.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL, fileURLToPath } = require('url');
const WORKER = require('./whisper-worker.py.cjs');

const UV_VERSION = '0.13.1', PYTHON_VERSION = '3.12';
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
// pywhispercpp has macOS Intel wheels only up to 1.2.0 (the API used here is the same).
const PACKAGE = MAC && process.arch !== 'arm64' ? 'pywhispercpp==1.2.0' : 'pywhispercpp==1.5.1';
const HF = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
// Times measured on 5 minutes of an episode (8 threads of a 12-thread desktop CPU): tiny / base 23 s, small 66 s,
// large-v3-turbo 190 s. small is the first that gets most lines right; turbo gets names and places too.
const MODELS = [
  { id: 'tiny', label: 'Tiny', file: 'ggml-tiny.bin', size: 77691713, note: '가장 빠르지만 자주 틀려요' },
  { id: 'base', label: 'Base', file: 'ggml-base.bin', size: 147951465, note: '빠름 · 대사를 반복해 만들어 내는 일이 있어요' },
  { id: 'small', label: 'Small', file: 'ggml-small.bin', size: 487601967, note: '권장 · 정확도와 속도의 균형 (재생보다 약 4배 빠름)' },
  { id: 'large-v3-turbo', label: 'Large v3 Turbo', file: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195, note: '가장 정확 · 고사양 CPU 권장 (재생보다 약 1.5배 빠름)' },
];

function uvAsset() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return MAC ? `uv-${arch}-apple-darwin.tar.gz` : WIN ? `uv-${arch}-pc-windows-msvc.zip` : `uv-${arch}-unknown-linux-gnu.tar.gz`;
}
function vttStamp(value) {
  const ms = Math.max(0, Math.round(value * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
const vttOf = lines => `WEBVTT\n\n${lines.slice().sort((a, b) => a.start - b.start).map(line => `${vttStamp(line.start)} --> ${vttStamp(Math.max(line.end, line.start + 0.5))}\n${line.text}\n`).join('\n')}`;

// proxy(url, headers): a stream address FFmpeg can read (segments some hosts disguise as pictures are cut at their
// video data by the app's local proxy).
function createWhisper({ userData, ffmpegPath, subtitleRoot, proxy = url => Promise.resolve(url) }) {
  const root = path.join(userData, 'tools', 'whisper'), venv = path.join(root, 'venv'), marker = path.join(root, 'installed.json');
  const python = path.join(venv, WIN ? 'Scripts/python.exe' : 'bin/python'), worker = path.join(root, 'worker.py');
  const modelDir = path.join(userData, 'whisper', 'models'), settingsFile = path.join(userData, 'whisper', 'settings.json');
  const outDir = path.join(subtitleRoot, 'whisper');
  const uvEnv = () => ({ ...process.env, UV_CACHE_DIR: path.join(root, 'cache'), UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_NO_PROGRESS: '1' });
  let installing = null, current = null; const downloads = new Map();

  const settings = () => { try { return { model: 'small', ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { return { model: 'small' }; } };
  const modelFile = id => path.join(modelDir, MODELS.find(model => model.id === id)?.file || 'none');
  const modelInstalled = id => { try { return fs.statSync(modelFile(id)).size >= MODELS.find(model => model.id === id).size * 0.98; } catch { return false; } };
  const runtimeInstalled = () => { try { return JSON.parse(fs.readFileSync(marker, 'utf8')).package === PACKAGE && fs.existsSync(python); } catch { return false; } };
  function status() {
    const picked = settings().model;
    return {
      runtime: runtimeInstalled(), installing: Boolean(installing), model: MODELS.some(model => model.id === picked) ? picked : 'small', running: current?.key || null,
      models: MODELS.map(model => {
        let partial = 0; try { partial = fs.statSync(`${modelFile(model.id)}.part`).size; } catch { /* none */ }
        return { ...model, installed: modelInstalled(model.id), partial, downloading: downloads.has(model.id) };
      }),
    };
  }
  function select(id) {
    if (!MODELS.some(model => model.id === id)) throw new Error('지원하지 않는 Whisper 모델입니다.');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ ...settings(), model: id }));
    return status();
  }

  function run(command, args, { env = process.env } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
      const take = chunk => { output = (output + chunk.toString('utf8')).slice(-20000); };
      child.stdout.on('data', take); child.stderr.on('data', take);
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(output) : reject(new Error(output.trim().split('\n').slice(-4).join(' ').slice(-400) || `${path.basename(command)} ${code}`)));
    });
  }
  // Into target.part first; a download cut short goes on from there the next time (an HTTP range request).
  async function download(url, target, progress) {
    const partial = `${target}.part`; let have = 0; try { have = fs.statSync(partial).size; } catch { /* nothing yet */ }
    const response = await fetch(url, { headers: { 'User-Agent': 'LilacAnime-Desktop', ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow' });
    if (have && response.status === 416) { fs.rmSync(partial, { force: true }); return download(url, target, progress); }
    if (!response.ok || !response.body) throw new Error(`다운로드 HTTP ${response.status}`);
    if (response.status !== 206) have = 0;
    const total = (Number(response.headers.get('content-length')) || 0) + have;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const out = fs.createWriteStream(partial, { flags: have ? 'a' : 'w' }); let done = have, last = 0;
    try {
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise(resolve => out.once('drain', resolve));
        done += chunk.length; if (Date.now() - last > 400) { last = Date.now(); progress(total ? done / total : 0); }
      }
      await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
    } catch (error) { out.destroy(); throw error; }
    if (total > have && done !== total) throw new Error('다운로드가 중간에 끊겼습니다. 다시 받으면 이어서 받습니다.');
    fs.renameSync(partial, target); progress(1);
  }
  function findFile(dir, name) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findFile(file, name); if (found) return found; } else if (entry.name === name) return file;
    }
    return null;
  }
  // uv → its own Python 3.12 → a venv with pywhispercpp and numpy. uv and its download cache are removed afterwards.
  function install(progress = () => {}) {
    if (runtimeInstalled()) return Promise.resolve(status());
    if (!installing) installing = (async () => {
      fs.mkdirSync(root, { recursive: true });
      const asset = uvAsset(), archive = path.join(root, asset), unpacked = path.join(root, 'uv');
      progress('uv 받는 중', 0);
      await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`, archive, done => progress('uv 받는 중', done * 0.3));
      fs.rmSync(unpacked, { recursive: true, force: true }); fs.mkdirSync(unpacked, { recursive: true });
      const tar = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
      try { await run(tar, [WIN ? '-xf' : '-xzf', archive, '-C', unpacked]); } finally { fs.rmSync(archive, { force: true }); }
      const uv = findFile(unpacked, WIN ? 'uv.exe' : 'uv');
      if (!uv) throw new Error('uv 실행 파일을 찾지 못했습니다.');
      if (!WIN) fs.chmodSync(uv, 0o755);
      progress('Python 준비 중', 0.35);
      fs.rmSync(venv, { recursive: true, force: true });
      await run(uv, ['venv', '--python', PYTHON_VERSION, '--managed-python', venv], { env: uvEnv() });
      progress('whisper.cpp 설치 중', 0.6);
      await run(uv, ['pip', 'install', '--python', python, PACKAGE, 'numpy'], { env: uvEnv() });
      for (const dir of ['cache', 'uv']) fs.rmSync(path.join(root, dir), { recursive: true, force: true });
      fs.writeFileSync(marker, JSON.stringify({ uv: UV_VERSION, package: PACKAGE, python: PYTHON_VERSION, at: Date.now() }));
      progress('설치 완료', 1);
      return status();
    })().finally(() => { installing = null; });
    return installing;
  }
  function downloadModel(id, progress = () => {}) {
    const model = MODELS.find(item => item.id === id);
    if (!model) throw new Error('지원하지 않는 Whisper 모델입니다.');
    if (modelInstalled(id)) return Promise.resolve(status());
    if (!downloads.has(id)) downloads.set(id, download(`${HF}${model.file}`, modelFile(id), done => progress(done)).then(status).finally(() => downloads.delete(id)));
    return downloads.get(id);
  }
  function removeModel(id) { for (const file of [modelFile(id), `${modelFile(id)}.part`]) fs.rmSync(file, { force: true }); return status(); }

  const fileFor = (key, model) => path.join(outDir, `${String(key).replace(/[^a-z0-9가-힣._-]+/gi, '_').slice(0, 120)}.${model}.vtt`);
  const result = (file, lines, complete) => ({ path: file, url: pathToFileURL(file).href, lines, complete });

  // One piece of the episode: FFmpeg from `from` (to `to`) into the worker's stdin; lines and progress as they come.
  function piece({ input, from, to, model, onLine, onAt, signal }) {
    return new Promise((resolve, reject) => {
      const threads = String(Math.max(2, Math.min(8, os.cpus().length - 2)));
      const py = spawn(python, [worker, modelFile(model), 'ja', threads, String(from)], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
      const ff = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...(from > 0 ? ['-ss', String(from)] : []), ...input.args, '-i', input.url, ...(to ? ['-t', String(Math.max(1, to - from))] : []),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      ff.stdout.pipe(py.stdin); py.stdin.on('error', () => {});
      let rest = '', errors = '', ffErrors = '';
      py.stdout.on('data', chunk => {
        rest += chunk.toString('utf8'); const lines = rest.split('\n'); rest = lines.pop();
        for (const line of lines) { let value; try { value = JSON.parse(line); } catch { continue; } if (value.text) onLine(value); else if (Number.isFinite(value.at)) onAt(value.at); }
      });
      py.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
      ff.stderr.on('data', chunk => { ffErrors = (ffErrors + chunk).slice(-2000); });
      const stop = () => { ff.kill(); py.kill(); };
      signal.addEventListener('abort', stop, { once: true });
      let ffCode = null; ff.once('close', code => { ffCode = code; });
      ff.once('error', reject); py.once('error', reject);
      py.once('close', code => {
        signal.removeEventListener('abort', stop);
        if (signal.aborted) return reject(Object.assign(new Error('취소했습니다.'), { canceled: true }));
        if (code !== 0) return reject(new Error(`Whisper 음성 인식에 실패했습니다: ${errors.trim().split('\n').slice(-2).join(' ').slice(-300) || code}`));
        if (ffCode && ffCode !== 0) return reject(new Error(`영상 음성을 읽지 못했습니다: ${ffErrors.trim().slice(-300) || ffCode}`));
        resolve();
      });
    });
  }

  // request: {key (the episode), videoUrl, headers, startAt (where it is playing), duration}. events(value): {lines},
  // {at, done} (seconds transcribed, of duration). A finished episode is given back at once; one run at a time (a new
  // episode stops the one before).
  async function transcribe({ key, videoUrl, headers = {}, startAt = 0, duration = 0 }, events = () => {}) {
    if (!runtimeInstalled()) throw new Error('Whisper가 아직 설치되지 않았습니다. 설정 > 자막 > Whisper AI 자막에서 설치해 주세요.');
    const model = status().model;
    if (!modelInstalled(model)) throw new Error(`Whisper ${MODELS.find(item => item.id === model).label} 모델을 먼저 받아 주세요 (설정 > 자막 > Whisper AI 자막).`);
    if (!key || !videoUrl) throw new Error('재생 중인 영상이 없습니다.');
    const file = fileFor(key, model), doneFile = `${file}.done`;
    if (fs.existsSync(file) && fs.existsSync(doneFile)) return result(file, JSON.parse(fs.readFileSync(doneFile, 'utf8')).lines || 0, true);
    cancel();
    fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(worker, WORKER);
    const controller = new AbortController(), run = { key, controller }; current = run;
    const lines = [], add = line => { lines.push(line); events({ lines: [line] }); };
    let covered = 0;
    try {
      const url = /^https?:\/\//i.test(videoUrl) && !/^https?:\/\/127\.0\.0\.1[:/]/i.test(videoUrl) && /\.m3u8(?:$|\?)/i.test(videoUrl) ? await proxy(videoUrl, headers) : videoUrl;
      const local = /^file:/i.test(url), remoteHeaders = !local && !/^https?:\/\/127\.0\.0\.1[:/]/i.test(url) ? Object.entries(headers || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\r\n') : '';
      const input = { url: local ? fileURLToPath(url) : url, args: [...(remoteHeaders ? ['-headers', `${remoteHeaders}\r\n`] : []), ...(/^https?:/i.test(url) ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [])] };
      // From a little before where it is playing to the end, then the beginning up to there.
      const from = startAt > 60 ? Math.max(0, startAt - 5) : 0, pieces = from ? [[from, 0], [0, from]] : [[0, 0]];
      for (const [start, to] of pieces) {
        let reached = start;
        await piece({ input, from: start, to, model, signal: controller.signal, onLine: add,
          onAt: at => { covered += at - reached; reached = at; events({ at, done: covered, duration }); } });
      }
      // The folder is made only now: the subtitle cleanup run a minute after start removes empty folders.
      fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, vttOf(lines)); fs.writeFileSync(doneFile, JSON.stringify({ lines: lines.length, model, at: Date.now() }));
      return result(file, lines.length, true);
    } catch (error) {
      // What was recognized before a stop stays (shown and saved), the run is not marked done.
      if (lines.length) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, vttOf(lines)); }
      throw error;
    } finally { if (current === run) current = null; }
  }
  function cancel() { current?.controller.abort(); current = null; return true; }

  return { status, select, install, downloadModel, removeModel, transcribe, cancel, MODELS };
}

module.exports = { createWhisper, vttOf, WHISPER_MODELS: MODELS };

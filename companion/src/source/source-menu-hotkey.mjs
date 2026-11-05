import { spawn } from 'node:child_process';
import path from 'node:path';

function escapePowerShell(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// A separate console is intentional: menu prompts should never compete with
// the long-running subtitle watcher for stdin/stdout.
export function launchSourceManager({
  exe = process.execPath,
  entrypoint = path.resolve(import.meta.dirname, '../main.mjs'),
  packaged = Boolean(process.pkg),
  platform = process.platform,
  spawnProcess = spawn
} = {}) {
  if (platform !== 'win32') throw new Error('The press-1 launcher currently requires Windows');
  const argv = packaged ? ['sources', 'menu'] : [entrypoint, 'sources', 'menu'];
  const wd = packaged ? path.dirname(exe) : path.dirname(path.dirname(entrypoint));
  const args = argv.map(item => '"' + item.replace(/"/g, '') + '"').join(' ');
  const command = 'Start-Process -FilePath ' + escapePowerShell(exe) +
    ' -WorkingDirectory ' + escapePowerShell(wd) +
    ' -ArgumentList ' + escapePowerShell(args);
  const child = spawnProcess('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, stdio: 'ignore' });
  child.on?.('error', error => console.warn('[companion] source manager launch failed: ' + error.message));
  child.unref?.();
  return child;
}

export function listenForSourceManager({
  input = process.stdin,
  open = () => launchSourceManager(),
  log = message => console.log(message)
} = {}) {
  log('[companion] 소스 관리 메뉴: 이 창에서 1 입력 후 Enter (별도 창이 열립니다)');
  if (!input || typeof input.on !== 'function' || !input.isTTY) {
    log('[companion] 입력 불가 환경이면 시작 메뉴의 Lilac Companion - Source Manager를 이용하세요.');
    return () => {};
  }
  input.setEncoding?.('utf8');
  let buffered = '';
  const onData = chunk => {
    buffered += String(chunk);
    if (buffered.length > 300) buffered = buffered.slice(-300);
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() !== '1') continue;
      try {
        open();
        log('[companion] 소스 관리 창을 여는 중입니다. 자동 감시는 계속됩니다.');
      } catch (error) {
        log('[companion] 소스 관리 창을 열 수 없습니다: ' + error.message);
      }
    }
  };
  input.on('data', onData);
  input.resume?.();
  return () => input.off?.('data', onData);
}

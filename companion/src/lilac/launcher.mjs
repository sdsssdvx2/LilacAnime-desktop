import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function powershell(script) {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8'
    });
    return String(stdout || '').trim();
  } catch { return ''; }
}

export async function runningLilacExecutable() {
  if (process.platform !== 'win32') return '';
  const value = await powershell("$p=Get-CimInstance Win32_Process -Filter \"Name='LilacAnime.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath; if($p){$p}");
  return value.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
}

async function registryCandidates() {
  if (process.platform !== 'win32') return [];
  const script = `
$roots=@(
'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
foreach($root in $roots){
  Get-ItemProperty $root -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'LilacAnime*' } |
    ForEach-Object {
      if($_.InstallLocation){ Join-Path $_.InstallLocation 'LilacAnime.exe' }
      if($_.DisplayIcon){ ($_.DisplayIcon -replace ',\\d+$','').Trim('"') }
    }
}`;
  const output = await powershell(script);
  return output.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

export async function discoverLilacExecutable() {
  const explicit = String(process.env.LILAC_EXE || '').trim();
  if (explicit && await exists(explicit)) return { path: explicit, source: 'env', running: false };

  const running = await runningLilacExecutable();
  if (running && await exists(running)) return { path: running, source: 'running-process', running: true };

  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const common = [
    local && path.join(local, 'Programs', 'LilacAnime', 'LilacAnime.exe'),
    local && path.join(local, 'LilacAnime', 'LilacAnime.exe'),
    programFiles && path.join(programFiles, 'LilacAnime', 'LilacAnime.exe')
  ].filter(Boolean);
  for (const candidate of common) if (await exists(candidate)) return { path: candidate, source: 'common-path', running: false };

  for (const candidate of await registryCandidates()) {
    if (/\.exe$/i.test(candidate) && await exists(candidate)) return { path: candidate, source: 'registry', running: false };
  }
  return null;
}

export async function launchLilacForCompanion(port = 9223) {
  const found = await discoverLilacExecutable();
  if (!found) throw new Error('LilacAnime.exe was not found. Set LILAC_EXE once if you use a portable/custom install.');
  if (found.running) {
    throw new Error('LilacAnime is already running without the Companion debugging port. Close Lilac once and start Companion again; Companion will not kill or reset Lilac automatically.');
  }
  const child = spawn(found.path, [`--remote-debugging-port=${Number(port) || 9223}`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
  return found;
}

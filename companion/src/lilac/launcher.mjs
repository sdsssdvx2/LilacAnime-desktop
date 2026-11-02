import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

function configPath() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'LilacCompanion', 'config.json');
}

async function readRememberedExecutable() {
  try {
    const json = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    const value = String(json?.lilacExe || '').trim();
    return value && await exists(value) ? value : '';
  } catch { return ''; }
}

async function rememberExecutable(file) {
  if (!file || !(await exists(file))) return;
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  let current = {};
  try { current = JSON.parse(await fs.readFile(target, 'utf8')); } catch {}
  await fs.writeFile(target, JSON.stringify({ ...current, lilacExe: file }, null, 2), 'utf8');
}

async function powershell(script, timeout = 7000) {
  if (process.platform !== 'win32') return '';
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      timeout,
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

async function shortcutCandidates() {
  if (process.platform !== 'win32') return [];
  const script = `
$roots=@(
  [Environment]::GetFolderPath('StartMenu'),
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory')
) | Where-Object { $_ -and (Test-Path $_) }
$ws=New-Object -ComObject WScript.Shell
foreach($root in $roots){
  Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object {
      try {
        $s=$ws.CreateShortcut($_.FullName)
        if($s.TargetPath -and ((Split-Path $s.TargetPath -Leaf) -ieq 'LilacAnime.exe')) { $s.TargetPath }
      } catch {}
    }
}`;
  const output = await powershell(script, 10000);
  return output.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
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
    Where-Object { $_.DisplayName -match '(?i)Lilac.*Anime|LilacAnime' } |
    ForEach-Object {
      if($_.InstallLocation){ Join-Path $_.InstallLocation 'LilacAnime.exe' }
      if($_.DisplayIcon){ ($_.DisplayIcon -replace ',\\d+$','').Trim('"') }
      if($_.UninstallString -match '"([^\"]+\\LilacAnime[^\"]*\\Uninstall[^\"]*\\.exe)"') {
        $dir=Split-Path $matches[1] -Parent
        Join-Path (Split-Path $dir -Parent) 'LilacAnime.exe'
      }
    }
}`;
  const output = await powershell(script);
  return output.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
}

async function chooseLilacExecutable() {
  if (process.platform !== 'win32' || process.env.CI) return '';
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = 'Lilac Companion - LilacAnime.exe 위치를 한 번만 선택하세요'
$dlg.Filter = 'LilacAnime 실행 파일 (LilacAnime.exe)|LilacAnime.exe|실행 파일 (*.exe)|*.exe'
$dlg.FileName = 'LilacAnime.exe'
$dlg.CheckFileExists = $true
$dlg.Multiselect = $false
if($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ $dlg.FileName }
`;
  const output = await powershell(script, 120000);
  return output.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && /LilacAnime\.exe$/i.test(candidate) && await exists(candidate)) return candidate;
  }
  return '';
}

export async function discoverLilacExecutable({ allowPicker = true } = {}) {
  const explicit = String(process.env.LILAC_EXE || '').trim();
  if (explicit && await exists(explicit)) {
    await rememberExecutable(explicit);
    return { path: explicit, source: 'env', running: false };
  }

  const running = await runningLilacExecutable();
  if (running && await exists(running)) {
    await rememberExecutable(running);
    return { path: running, source: 'running-process', running: true };
  }

  const remembered = await readRememberedExecutable();
  if (remembered) return { path: remembered, source: 'remembered', running: false };

  const local = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';
  const common = [
    local && path.join(local, 'Programs', 'LilacAnime', 'LilacAnime.exe'),
    local && path.join(local, 'Programs', 'lilacanime-desktop', 'LilacAnime.exe'),
    local && path.join(local, 'LilacAnime', 'LilacAnime.exe'),
    programFiles && path.join(programFiles, 'LilacAnime', 'LilacAnime.exe'),
    programFilesX86 && path.join(programFilesX86, 'LilacAnime', 'LilacAnime.exe')
  ].filter(Boolean);
  const commonHit = await firstExisting(common);
  if (commonHit) {
    await rememberExecutable(commonHit);
    return { path: commonHit, source: 'common-path', running: false };
  }

  const shortcutHit = await firstExisting(await shortcutCandidates());
  if (shortcutHit) {
    await rememberExecutable(shortcutHit);
    return { path: shortcutHit, source: 'shortcut', running: false };
  }

  const registryHit = await firstExisting(await registryCandidates());
  if (registryHit) {
    await rememberExecutable(registryHit);
    return { path: registryHit, source: 'registry', running: false };
  }

  if (allowPicker) {
    const picked = await chooseLilacExecutable();
    if (picked && /LilacAnime\.exe$/i.test(picked) && await exists(picked)) {
      await rememberExecutable(picked);
      return { path: picked, source: 'picker', running: false };
    }
  }
  return null;
}

export async function launchLilacForCompanion(port = 9223) {
  const found = await discoverLilacExecutable({ allowPicker: true });
  if (!found) throw new Error('LilacAnime.exe was not found. Companion could not resolve a shortcut, registry entry, remembered path, or user-selected executable.');
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

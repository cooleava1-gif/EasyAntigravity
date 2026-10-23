const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function normalizePath(value) {
  if (!value || process.platform !== 'win32') return value;
  if (value.startsWith('\\\\?\\UNC\\')) return '\\\\' + value.slice(8);
  return value.startsWith('\\\\?\\') ? value.slice(4) : value;
}

function discoverDesktop() {
  const explicit = normalizePath(process.env.EASYAG_AG_EXE);
  if (explicit) return { appDir: path.dirname(explicit), appExe: explicit, appName: 'Antigravity' };
  if (process.platform === 'darwin') {
    const candidates = ['/Applications/Antigravity.app', path.join(os.homedir(), 'Applications/Antigravity.app')];
    const bundle = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
    let executable = 'Antigravity';
    if (fs.existsSync(bundle)) {
      try {
        executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8', timeout: 3000 }).trim();
      } catch { /* Older bundles may not advertise their entrypoint. */ }
    }
    return { appDir: bundle, appExe: path.join(bundle, 'Contents/MacOS', executable), appName: 'Antigravity' };
  }
  const appDir = path.join(process.env.LOCALAPPDATA || '', 'Programs/antigravity');
  return { appDir, appExe: path.join(appDir, 'Antigravity.exe'), appName: 'Antigravity' };
}

// AG 的 sidecar 服务经 cmd 包装以 Antigravity.exe 的 node 模式运行（--import=... dist/server.cjs），
// 与 IDE 本体共用 exe 名，且 IDE 退出后仍会驻留；只按进程名判断会把残留 sidecar 误判成“AG 正在运行”。
const SIDECAR_PATTERN = /(--import=|server\.cjs)/i;

function isSidecarCommandLine(commandLine) {
  return SIDECAR_PATTERN.test(String(commandLine || ''));
}

function hasIdeProcess(commandLines) {
  return commandLines.some(line => !isSidecarCommandLine(line));
}

async function ideCommandLines() {
  const script = 'Get-CimInstance Win32_Process -Filter "Name=\'Antigravity.exe\'" | ForEach-Object { $_.CommandLine }';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 });
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function desktopRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000 });
      if (!/"Antigravity\.exe"/i.test(stdout)) return false;
      try {
        const lines = await ideCommandLines();
        // 命令行整体不可见时（如权限差异）无法区分，维持旧行为按“正在运行”处理
        return lines.length === 0 ? true : hasIdeProcess(lines);
      } catch { return true; }
    }
    const { stdout } = await run('pgrep', ['-x', 'Antigravity'], { timeout: 4000 });
    return /^\d+/m.test(stdout);
  } catch { return false; }
}

module.exports = { normalizePath, discoverDesktop, desktopRunning, isSidecarCommandLine, hasIdeProcess };

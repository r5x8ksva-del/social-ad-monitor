// 找本机工具：PATH 里的命令（ffmpeg、python3）和浏览器的默认安装位置。Windows、macOS、Linux 通用。
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };

// 带路径的直接看文件在不在；不带路径的按 PATH 找（Windows 上补 .exe、.cmd 这些扩展名）。找不到返回 null
export function findCommand(cmd, { platform = process.platform, env = process.env } = {}) {
  if (!cmd) return null;
  if (/[\\/]/.test(cmd)) return isFile(cmd) ? cmd : null;
  const exts = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const dir of (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const f = join(dir, cmd + ext);
      if (isFile(f)) return f;
    }
  }
  return null;
}

// Playwright 按「频道」找本机已装的浏览器；这里按同样的默认位置检查，给网页上的环境检查用
export function browserCandidates(channel, { platform = process.platform, env = process.env } = {}) {
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = env.LOCALAPPDATA || '';
  const table = {
    msedge: {
      win32: [join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), local && join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      linux: ['/opt/microsoft/msedge/msedge'],
    },
    chrome: {
      win32: [join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      linux: ['/opt/google/chrome/chrome'],
    },
  };
  const list = table[channel]?.[platform];
  return list ? list.filter(Boolean) : null; // null：这个频道不认识，不检查
}

export function browserInstalled(channel) {
  const list = browserCandidates(channel);
  return list === null ? null : list.some((f) => existsSync(f));
}

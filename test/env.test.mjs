// 本机工具路径：配置里的相对路径怎么算、PATH 里怎么找命令、各系统上浏览器装在哪
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../src/db.mjs';
import { toolPath, defaultPython, tools } from '../app/store.mjs';
import { findCommand, browserCandidates } from '../app/lib/env.mjs';

test('配置里的路径：带斜杠的相对路径按项目根目录算，命令名留给 PATH，绝对路径照用', () => {
  assert.equal(toolPath('ffmpeg'), 'ffmpeg');
  assert.equal(toolPath('python3'), 'python3');
  assert.equal(toolPath('asr/.venv/bin/python'), resolve(ROOT, 'asr/.venv/bin/python'));
  const abs = resolve(ROOT, 'x', 'y.exe');
  assert.equal(toolPath(abs), abs);
  assert.equal(toolPath(''), '');
  assert.equal(defaultPython('win32'), 'asr/.venv/Scripts/python.exe');
  assert.equal(defaultPython('darwin'), 'asr/.venv/bin/python');
  assert.equal(defaultPython('linux'), 'asr/.venv/bin/python');
});

test('环境变量优先于配置：Python、模型目录、ffmpeg、浏览器频道', () => {
  const t = tools({ SAM_PYTHON: 'python3', ASR_HOME: 'models-here', FFMPEG: 'tools/ffmpeg', SAM_BROWSER_CHANNEL: 'chrome' });
  assert.deepEqual(t, { python: 'python3', asrHome: resolve(ROOT, 'models-here'), ffmpeg: resolve(ROOT, 'tools/ffmpeg'), browserChannel: 'chrome' });
  const abs = resolve(tmpdir(), 'asr-models');
  assert.equal(tools({ ASR_HOME: abs }).asrHome, abs);
});

test('按 PATH 找命令：Windows 补扩展名；带路径的只看文件在不在；找不到返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-env-'));
  try {
    const exe = join(dir, process.platform === 'win32' ? 'fakecmd.EXE' : 'fakecmd');
    writeFileSync(exe, '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT' };
    const found = findCommand('fakecmd', { env });
    assert.ok(found && found.toLowerCase() === exe.toLowerCase(), found);
    assert.equal(findCommand('nosuchcmd', { env }), null);
    assert.equal(findCommand(exe), exe);
    assert.equal(findCommand(join(dir, 'missing.exe')), null);
    assert.equal(findCommand(dir), null); // 目录不算
    assert.equal(findCommand(''), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('浏览器默认安装位置：Edge、Chrome 三个系统；不认识的频道不检查', () => {
  const win = browserCandidates('msedge', { platform: 'win32', env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LOCALAPPDATA: 'C:\\LA' } });
  assert.equal(win.length, 3);
  assert.ok(win.every((f) => f.endsWith('msedge.exe')));
  assert.ok(win.some((f) => f.startsWith('C:\\LA')));
  assert.deepEqual(browserCandidates('msedge', { platform: 'darwin', env: {} }), ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
  assert.deepEqual(browserCandidates('msedge', { platform: 'linux', env: {} }), ['/opt/microsoft/msedge/msedge']);
  assert.deepEqual(browserCandidates('chrome', { platform: 'linux', env: {} }), ['/opt/google/chrome/chrome']);
  assert.equal(browserCandidates('chrome', { platform: 'win32', env: {} }).length, 2); // 没有 LOCALAPPDATA 就少一个
  assert.equal(browserCandidates('chromium', { platform: 'linux', env: {} }), null);
});

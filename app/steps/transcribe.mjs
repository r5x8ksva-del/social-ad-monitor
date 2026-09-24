// ⑤ 本机转写：起 asrShards 个 app/asr_worker.py 进程（按文件名分片），和采集同时跑——采集那边每下完一条音频，这边就能转。
// 采集结束时 runner 往标记文件里写 exit=，转写进程把剩下的转完就退出。模型在 config/app.json 的 asrHome（SenseVoice + Silero VAD）。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../src/db.mjs';
import { APP, tools } from '../store.mjs';
import { findCommand } from '../lib/env.mjs';

export function asrPending(p) {
  return readdirSync(p.audio).filter((f) => f.endsWith('.m4a'))
    .map((f) => f.slice(0, -4))
    .filter((b) => !existsSync(join(p.asr, `${b}.json`)) && !existsSync(join(p.asr, `${b}.error.json`)));
}

export async function transcribe(ctx, { watchFile = null } = {}) {
  const { p, signal } = ctx;
  const t = tools();
  const python = findCommand(t.python);
  if (!python) throw new Error(`找不到转写用的 Python：${t.python}（在 config/app.json 的 python 里改，见 README「安装」）`);
  const shards = Math.max(1, APP.asrShards ?? 3), threads = Math.max(1, APP.asrThreads ?? 4);
  const env = { ...process.env, ASR_HOME: t.asrHome, FFMPEG: findCommand(t.ffmpeg) ?? t.ffmpeg, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  let done = 0, failed = 0, audioSec = 0, cpuSec = 0;
  const report = (note) => ctx.progress(done + failed, done + failed + asrPending(p).length, note);
  report(watchFile ? '等采集下来的音频' : '');

  const runOne = (i) => new Promise((resolve, reject) => {
    const args = [join(ROOT, 'app', 'asr_worker.py'), '--audio-dir', p.audio, '--out-dir', p.asr, '--shard', `${i}/${shards}`,
      '--threads', String(threads), '--parent', String(process.pid), ...(watchFile ? ['--watch', watchFile] : [])];
    const child = spawn(python, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const kill = () => child.kill();
    signal.addEventListener('abort', kill, { once: true });
    let buf = '', errTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.event === 'start' && e.efficiency === false) ctx.log(`转写进程 ${i} 没能退出效率模式，会慢一些`, 'warn');
        if (e.event === 'done') {
          done++; audioSec += e.seconds; cpuSec += e.took;
          report(`${e.bvid} ${(e.seconds / 60).toFixed(1)} 分钟`);
        }
        if (e.event === 'error') { failed++; ctx.log(`${e.bvid} 转写失败：${e.error}`, 'warn'); report(''); }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errTail = (errTail + chunk).slice(-800); });
    child.on('error', (e) => reject(new Error(`转写进程启动失败：${e.message}`)));
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) reject(signal.reason ?? new Error('已停止'));
      else if (code === 0) resolve();
      else reject(new Error(`转写进程 ${i} 退出码 ${code}：${errTail.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });

  const results = await Promise.allSettled(Array.from({ length: shards }, (_, i) => runOne(i)));
  if (signal.aborted) throw signal.reason ?? new Error('已停止');
  Object.assign(ctx.stats, { transcribed: done, asrFailed: failed, audioMinutes: Math.round(audioSec / 60) });
  const took = cpuSec < 60 ? `${Math.round(cpuSec)} 秒` : `${Math.round(cpuSec / 60)} 分钟`;
  if (done) ctx.log(`转写 ${done} 条、共 ${Math.round(audioSec / 60)} 分钟音频（各进程合计用时 ${took}，${shards} 路并行）`);
  const bad = results.filter((r) => r.status === 'rejected');
  if (bad.length) throw bad[0].reason;
}

// 一轮运行：按顺序跑十个步骤（采集和转写同时跑），记下每步的状态、进度和日志，并通过 bus 推给网页。
// 出错策略：B站 限制访问（RiskError）→ 碰 B站 的步骤全部跳过，已采到的继续转写、判定、汇总；
// 其他步骤出错 → 记下来接着跑后面的步骤（后面的步骤只处理「还没做的」，缺什么下一轮补）；手动停止 → 立刻停。
import { EventEmitter } from 'node:events';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BiliClient, RiskError } from '../src/client.mjs';
import { paths, openStore, loadSettings, acquireLock, releaseLock, readLock, getMeta, setMeta } from './store.mjs';
import { discover } from './steps/discover.mjs';
import { scopeStep } from './steps/scope.mjs';
import { comments } from './steps/comments.mjs';
import { collect } from './steps/collect.mjs';
import { transcribe } from './steps/transcribe.mjs';
import { label } from './steps/label.mjs';
import { second } from './steps/second.mjs';
import { frames } from './steps/frames.mjs';
import { vision } from './steps/vision.mjs';
import { places } from './steps/places.mjs';
import { leads } from './steps/leads.mjs';

export const bus = new EventEmitter();
bus.setMaxListeners(100);
const emit = (e) => bus.emit('event', e);

export const STEPS = [
  { id: 'discover', title: '发现新视频', desc: '按关键词翻公开搜索结果', bili: true },
  { id: 'scope', title: '划范围', desc: '时间窗、时长、品类词、宠物规则' },
  { id: 'comments', title: '评论区与初筛', desc: '置顶评论和热评，打推广分排队', bili: true },
  { id: 'collect', title: '采集页面和音频', desc: '无头 Edge 游客打开视频页', bili: true },
  { id: 'transcribe', title: '本机转写', desc: 'SenseVoice，和采集同时跑' },
  { id: 'label', title: '大模型判定', desc: '推广段、披露、疑似问题、原话核对' },
  { id: 'second', title: '第二模型交叉检验', desc: '另一家模型独立再判', when: (s) => s.secondModel, off: '设置里关掉了第二模型' },
  { id: 'frames', title: '取帧', desc: '只下推广段附近的画面分片', bili: true, when: (s) => s.vision, off: '设置里关掉了画面检查' },
  { id: 'vision', title: '读画面文字', desc: '视觉模型抄字，代码找关键词', when: (s) => s.vision, off: '设置里关掉了画面检查' },
  { id: 'places', title: '识别地区', desc: '内容里写到的城市（发布地要平台提供）', when: (s) => s.placeDetect, off: '设置里关掉了地区识别' },
  { id: 'leads', title: '汇总线索', desc: '合并结论、对品牌方所在地、导出表格' },
];
const RUNNERS = { discover, scope: scopeStep, comments, collect, transcribe, label, second, frames, vision, places, leads };
export const TRIGGERS = { manual: '手动', schedule: '定时', cli: '命令行' };

export class BusyError extends Error {}

let current = null;
export const currentRun = () => current;

const pad = (n) => String(n).padStart(2, '0');
const newRunId = (d = new Date()) => `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const fmtTime = (sec) => { const d = new Date(sec * 1000); return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

// 这一轮从哪个发布时间开始找：上一轮「发现」成功跑完的时刻往前多看 1 天（搜索收录有延迟），但最多回溯 maxLookbackDays 天；第一轮回溯 firstRunDays 天
export function computeSince(db, settings, nowSec) {
  const through = Number(getMeta(db, 'discoveredThrough')) || 0;
  if (!through) return nowSec - settings.firstRunDays * 86400;
  return Math.max(through - 86400, nowSec - settings.maxLookbackDays * 86400);
}

// 划范围用的发布时间下限：监测开始以后发布、这一轮才第一次搜到的视频也算（搜索收录可能晚，不能因为早于这一轮的起点就漏掉），
// 但最多回溯 maxLookbackDays 天。搜索结果里混进来的旧视频照样排除。
export function scopeCutoff(db, settings, nowSec, since) {
  const start = Number(getMeta(db, 'monitorStart')) || since;
  return Math.max(Math.min(start, since), nowSec - settings.maxLookbackDays * 86400);
}

// 服务或命令行启动时：上次没跑完就退出的轮次标成「中断」（另一个进程正在跑的那一轮除外）
export function markInterrupted(db, p) {
  const live = readLock(p);
  const at = new Date().toISOString();
  const rows = db.prepare("SELECT run_id FROM runs WHERE status = 'running'").all().filter((r) => r.run_id !== live?.runId);
  for (const r of rows) {
    db.prepare("UPDATE runs SET status = 'interrupted', finished_at = ? WHERE run_id = ?").run(at, r.run_id);
    db.prepare("UPDATE run_steps SET status = 'interrupted', finished_at = ? WHERE run_id = ? AND status = 'running'").run(at, r.run_id);
    db.prepare("UPDATE run_steps SET status = 'not-run' WHERE run_id = ? AND status = 'pending'").run(r.run_id);
  }
  return rows.length;
}

function log(ctx, step, level, msg) {
  const ts = new Date().toISOString();
  const r = ctx.db.prepare('INSERT INTO events (run_id, ts, level, step, msg) VALUES (?, ?, ?, ?, ?)').run(ctx.runId, ts, level, step, msg);
  emit({ type: 'log', id: Number(r.lastInsertRowid), runId: ctx.runId, ts, level, step, msg });
}

function setStep(ctx, id, fields) {
  const cols = Object.keys(fields);
  ctx.db.prepare(`UPDATE run_steps SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE run_id = ? AND step = ?`).run(...cols.map((c) => fields[c]), ctx.runId, id);
  const row = ctx.db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND step = ?').get(ctx.runId, id);
  emit({ type: 'step', runId: ctx.runId, ...row });
}

// 进度最多每 0.4 秒写一次库、推一次网页；步骤结束时补上最后一次
function progressOf(ctx, id, last) {
  let at = 0;
  return (done, total, note = '') => {
    last.value = { done, total, note: String(note ?? '').slice(0, 200) };
    if (Date.now() - at < 400 && done < total) return;
    at = Date.now();
    setStep(ctx, id, last.value);
  };
}

async function runStep(ctx, id, failures, opts) {
  const meta = STEPS.find((s) => s.id === id);
  if (meta.when && !meta.when(ctx.settings)) { setStep(ctx, id, { status: 'skipped', note: meta.off }); return; }
  if (meta.bili && ctx.biliBlocked) { setStep(ctx, id, { status: 'skipped', note: 'B站 已停手，这一步跳过' }); return; }
  ctx.signal.throwIfAborted();
  const t0 = Date.now();
  setStep(ctx, id, { status: 'running', started_at: new Date().toISOString() });
  const last = { value: null };
  let summary = null; // 步骤最后一条普通日志就是它的结果摘要，完成后显示在步骤列表里
  const sctx = { ...ctx, step: id, log: (msg, level = 'info') => { if (level === 'info') summary = msg; log(ctx, id, level, msg); }, progress: progressOf(ctx, id, last) };
  const finish = (status, note) => setStep(ctx, id, { ...(last.value ?? {}), status, finished_at: new Date().toISOString(), ...(note ? { note: String(note).slice(0, 300) } : {}) });
  try {
    await RUNNERS[id](sctx, opts);
    finish('done', summary);
    if (id === 'discover') setMeta(ctx.db, 'discoveredThrough', Math.floor(ctx.startedMs / 1000));
    ctx.stats.stepSeconds = { ...(ctx.stats.stepSeconds ?? {}), [id]: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    if (ctx.signal.aborted) { finish('stopped', '手动停止'); throw e; }
    if (e instanceof RiskError) {
      ctx.biliBlocked = e.message;
      finish('blocked', e.message);
      log(ctx, id, 'error', `B站 限制访问：${e.message}。后面碰 B站 的步骤都跳过，已经采到的继续转写和判定`);
      return;
    }
    failures.push({ step: id, error: String(e.message ?? e) });
    finish('failed', e.message);
    log(ctx, id, 'error', `出错：${e.message ?? e}`);
  }
}

async function execute(ctx) {
  const { db, p, runId } = ctx;
  const failures = [];
  let status = 'done', error = null;
  try {
    for (const id of ['discover', 'scope', 'comments']) await runStep(ctx, id, failures);
    // 采集和转写同时跑：采集结束往标记文件写 exit=，转写进程把剩下的转完就退出
    const flag = join(p.logs, `collect-${runId}.flag`);
    writeFileSync(flag, 'collecting\n');
    const asr = runStep(ctx, 'transcribe', failures, { watchFile: flag });
    asr.catch(() => {}); // 采集那边先出错时，下面不会 await 到它；先接住免得变成未处理的拒绝
    try { await runStep(ctx, 'collect', failures); } finally { appendFileSync(flag, 'exit=collect-finished\n'); }
    await asr;
    for (const id of ['label', 'second', 'frames', 'vision', 'places', 'leads']) await runStep(ctx, id, failures);
  } catch (e) {
    if (ctx.signal.aborted) status = 'stopped';
    else { status = 'failed'; error = String(e.message ?? e); }
  }
  if (status === 'done') status = ctx.biliBlocked ? 'blocked' : failures.length ? 'partial' : 'done';
  if (status === 'stopped') db.prepare("UPDATE run_steps SET status = 'not-run' WHERE run_id = ? AND status = 'pending'").run(runId);
  const stats = { ...ctx.stats, requests: ctx.requests(), failures, biliBlocked: ctx.biliBlocked, seconds: Math.round((Date.now() - ctx.startedMs) / 1000) };
  const note = error ?? ctx.biliBlocked ?? (failures.length ? failures.map((f) => `${STEPS.find((s) => s.id === f.step)?.title}：${f.error}`).join('；') : null);
  db.prepare('UPDATE runs SET finished_at = ?, status = ?, stats = ?, tokens = ?, error = ? WHERE run_id = ?')
    .run(new Date().toISOString(), status, JSON.stringify(stats), JSON.stringify(ctx.tokens), note, runId);
  const NAMES = { done: '跑完了', partial: '跑完了，但有步骤出错', blocked: '被 B站 限制访问，提前收尾', stopped: '手动停止', failed: '出错停止' };
  const took = stats.seconds < 60 ? `${stats.seconds} 秒` : `${Math.round(stats.seconds / 60)} 分钟`;
  log(ctx, null, status === 'done' ? 'info' : status === 'stopped' ? 'warn' : 'error', `这一轮${NAMES[status]}，用时 ${took}`);
  return status;
}

export function startRun({ trigger = 'manual' } = {}) {
  if (current) throw new BusyError('已经有一轮在跑');
  const p = paths();
  const db = openStore(p);
  const started = new Date();
  const runId = newRunId(started);
  const lock = acquireLock(p, runId);
  if (!lock.ok) throw new BusyError(`另一个进程（进程号 ${lock.holder?.pid ?? '未知'}，${lock.holder?.runId ?? ''}）正在跑这个工作区`);
  try {
    const settings = loadSettings(p);
    const nowSec = Math.floor(started.getTime() / 1000);
    const since = computeSince(db, settings, nowSec);
    if (!getMeta(db, 'monitorStart')) setMeta(db, 'monitorStart', since);
    const cutoff = scopeCutoff(db, settings, nowSec, since);
    db.prepare('INSERT INTO runs (run_id, trigger, started_at, status, since, settings) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, trigger, started.toISOString(), 'running', since, JSON.stringify(settings));
    const ins = db.prepare('INSERT INTO run_steps (run_id, step, status, done, total) VALUES (?, ?, ?, 0, 0)');
    for (const s of STEPS) ins.run(runId, s.id, 'pending');
    const controller = new AbortController();
    let client = null, ready = null;
    const ctx = {
      db, p, settings, runId, since, scopeCutoff: cutoff, signal: controller.signal, stats: {}, tokens: { label: 0, second: 0, vision: 0, places: 0 },
      biliBlocked: null, startedMs: started.getTime(),
      throwIfAborted: () => controller.signal.throwIfAborted(),
      addTokens: (k, n) => { ctx.tokens[k] = (ctx.tokens[k] ?? 0) + (n || 0); },
      // B站 客户端第一次用到时才取游客 cookie
      bili: async () => { client ??= new BiliClient({ logPath: p.requests }); ready ??= client.init(); await ready; return client; },
      requests: () => client?.requests ?? 0,
    };
    current = { runId, controller, trigger, startedAt: started.toISOString() };
    emit({ type: 'run', runId, status: 'running' });
    log(ctx, null, 'info', `开始（${TRIGGERS[trigger] ?? trigger}），找 ${fmtTime(since)} 以后发布的视频`);
    const promise = execute(ctx).finally(() => {
      releaseLock(p);
      current = null;
      emit({ type: 'run', runId, status: db.prepare('SELECT status FROM runs WHERE run_id = ?').get(runId)?.status });
    });
    current.promise = promise;
    return { runId, promise };
  } catch (e) {
    releaseLock(p);
    current = null;
    throw e;
  }
}

export function stopRun() {
  if (!current) return false;
  current.controller.abort(new Error('手动停止'));
  return true;
}

// 自动监测的工作区：路径、库表、设置、运行锁。和研究版的 data/ 完全分开，研究数据不会被改动。
// 工作区默认在 config/app.json 的 workspace，环境变量 SAM_WORKSPACE 可以换到别处（测试用临时目录）。
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { ROOT } from '../src/db.mjs';
import { parseBrandTable } from './lib/places.mjs';

// 本机配置：config/app.json（各人自己的机器，不进仓库）；没有就用 config/app.example.json 的默认值
const APP_FILE = join(ROOT, 'config', 'app.json');
export const APP = JSON.parse(readFileSync(existsSync(APP_FILE) ? APP_FILE : join(ROOT, 'config', 'app.example.json'), 'utf8'));

// 工具路径：绝对路径照用；带斜杠的相对路径按项目根目录算；不带斜杠的（ffmpeg、python3）当作 PATH 里的命令
export const toolPath = (v) => (!v || isAbsolute(v) || !/[\\/]/.test(v) ? v : resolve(ROOT, v));
export const defaultPython = (platform = process.platform) => (platform === 'win32' ? 'asr/.venv/Scripts/python.exe' : 'asr/.venv/bin/python');
// 环境变量优先，其次 config，最后是默认（转写环境在项目里的 asr/ 目录，ffmpeg 在 PATH 里，浏览器用本机 Edge）
export function tools(env = process.env) {
  return {
    python: toolPath(env.SAM_PYTHON || APP.python || defaultPython()),
    asrHome: resolve(ROOT, env.ASR_HOME || APP.asrHome || 'asr'),
    ffmpeg: toolPath(env.FFMPEG || APP.ffmpeg || 'ffmpeg'),
    browserChannel: env.SAM_BROWSER_CHANNEL || APP.browserChannel || 'msedge',
  };
}

export function workspaceRoot() {
  const p = process.env.SAM_WORKSPACE || APP.workspace || 'workspace';
  return isAbsolute(p) ? p : resolve(ROOT, p);
}

export function paths(dir = workspaceRoot()) {
  // 统一成本机写法（反斜杠）：网页服务靠「文件路径以工作区开头」判断有没有越界，C:/… 和 C:\… 混用会误判
  const root = resolve(dir);
  const logs = join(root, 'logs');
  return {
    root, logs,
    db: join(root, 'monitor.sqlite'),
    settings: join(root, 'settings.json'),
    lock: join(root, 'run.lock'),
    requests: join(logs, 'requests.jsonl'),
    evidence: join(root, 'evidence'),
    manifest: join(root, 'evidence', 'manifest.jsonl'),
    audio: join(root, 'audio'),
    asr: join(root, 'asr'),
    frames: join(root, 'frames'),
    framesManifest: join(root, 'frames', 'manifest.jsonl'),
    exports: join(root, 'exports'),
  };
}

export function ensureDirs(p) {
  for (const d of [p.root, p.logs, p.evidence, p.audio, p.asr, p.frames, p.exports]) mkdirSync(d, { recursive: true });
}

// 视频、命中、评论的表结构沿用研究版；深度环节每步一张表，「做没做过」直接看表里有没有这一行
const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS videos (
    bvid TEXT PRIMARY KEY, aid INTEGER, mid INTEGER, author TEXT, title TEXT, description TEXT, tags TEXT, typename TEXT,
    duration_s INTEGER, pubdate INTEGER, play INTEGER, danmaku INTEGER, replies INTEGER, favorites INTEGER, likes INTEGER,
    is_union INTEGER, first_seen TEXT, last_seen TEXT, first_run TEXT, raw TEXT
  );
  CREATE TABLE IF NOT EXISTS hits (bvid TEXT, keyword TEXT, run_id TEXT, page INTEGER, rank INTEGER, fetched_at TEXT, PRIMARY KEY (bvid, keyword));
  CREATE TABLE IF NOT EXISTS comments (
    bvid TEXT PRIMARY KEY, fetched_at TEXT, code INTEGER, top_text TEXT, top_by_up INTEGER, top_links TEXT, top_like INTEGER, hot TEXT, total INTEGER
  );
  CREATE TABLE IF NOT EXISTS screening (
    bvid TEXT PRIMARY KEY, run_id TEXT, in_scope INTEGER, scope_note TEXT, pet INTEGER,
    score REAL, priority REAL, features TEXT, reasons TEXT, screened_at TEXT
  );
  CREATE TABLE IF NOT EXISTS media (
    bvid TEXT PRIMARY KEY, run_id TEXT, fetched_at TEXT, http INTEGER, has_data INTEGER, audio_ok INTEGER, audio_bytes INTEGER,
    audio_sha256 TEXT, audio_deleted INTEGER DEFAULT 0, label_hits TEXT, error TEXT, attempts INTEGER DEFAULT 0,
    files TEXT, browser TEXT, script TEXT
  );
  CREATE TABLE IF NOT EXISTS labels (
    bvid TEXT PRIMARY KEY, run_id TEXT, model TEXT, labeled_at TEXT, ms INTEGER, tokens INTEGER, output TEXT,
    disclosure_level TEXT, has_link INTEGER, flags TEXT, grade TEXT, quotes TEXT, error TEXT
  );
  CREATE TABLE IF NOT EXISTS second_labels (
    bvid TEXT PRIMARY KEY, run_id TEXT, model TEXT, labeled_at TEXT, ms INTEGER, tokens INTEGER, output TEXT, error TEXT
  );
  CREATE TABLE IF NOT EXISTS frames (
    bvid TEXT PRIMARY KEY, run_id TEXT, fetched_at TEXT, ok INTEGER, stream TEXT, frames TEXT, bytes INTEGER, requests INTEGER,
    error TEXT, attempts INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS vision (
    file TEXT PRIMARY KEY, bvid TEXT, t INTEGER, sha256 TEXT, model TEXT, read_at TEXT, tokens INTEGER, texts TEXT, error TEXT
  );
  CREATE INDEX IF NOT EXISTS vision_bvid ON vision (bvid);
  CREATE TABLE IF NOT EXISTS leads (
    bvid TEXT PRIMARY KEY, updated_at TEXT, first_run TEXT, commercial TEXT, form TEXT, grade TEXT, disclosure TEXT,
    flags TEXT, attention TEXT, status TEXT, promo INTEGER
  );
  CREATE TABLE IF NOT EXISTS reviews (
    bvid TEXT PRIMARY KEY, reviewer TEXT, reviewed_at TEXT, verdict TEXT, commercial TEXT, form TEXT,
    remove_flags TEXT, frame_disclosed INTEGER, note TEXT
  );
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, trigger TEXT, started_at TEXT, finished_at TEXT, status TEXT, since INTEGER,
    settings TEXT, stats TEXT, tokens TEXT, error TEXT
  );
  CREATE TABLE IF NOT EXISTS run_steps (
    run_id TEXT, step TEXT, status TEXT, started_at TEXT, finished_at TEXT, done INTEGER, total INTEGER, note TEXT,
    PRIMARY KEY (run_id, step)
  );
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, ts TEXT, level TEXT, step TEXT, msg TEXT);
  CREATE INDEX IF NOT EXISTS events_run ON events (run_id);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  -- 发布地：平台依法提供（导入表格）或人工录入；B站 游客看不到
  CREATE TABLE IF NOT EXISTS publish_locations (
    bvid TEXT PRIMARY KEY, province TEXT, city TEXT, source TEXT, note TEXT, updated_at TEXT, by TEXT
  );
  -- 内容城市：大模型从材料里认出的城市（已统一名字、核对过原话）
  CREATE TABLE IF NOT EXISTS places (
    bvid TEXT PRIMARY KEY, run_id TEXT, model TEXT, extracted_at TEXT, tokens INTEGER, output TEXT, error TEXT
  );
`;

// 旧工作区升级：新加的列补上
const COLUMNS = [['leads', 'places', 'TEXT']];

// 同一个进程里网页和流水线共用一个连接（node:sqlite 是同步的，不会交错写半条）
const dbs = new Map();
export function openStore(p) {
  const cached = dbs.get(p.db);
  if (cached && cached.isOpen !== false) return cached; // 关掉过的连接（测试里会关）重新开
  ensureDirs(p);
  const db = new DatabaseSync(p.db);
  db.exec(SCHEMA);
  for (const [table, col, type] of COLUMNS) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  dbs.set(p.db, db);
  return db;
}

export const getMeta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
export const setMeta = (db, key, value) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  .run(key, value == null ? null : String(value));

// ── 设置 ──
// 口径（关键词、品类词、品牌…）第一次从 config/health.json 取，之后以工作区里的 settings.json 为准（网页上改的就是它）
export function defaultSettings() {
  const c = JSON.parse(readFileSync(join(ROOT, 'config', 'health.json'), 'utf8'));
  // 品牌方所在地对照表的初始内容：config/brand-places.json 里核实过的条目（每条带来源）
  const bp = join(ROOT, 'config', 'brand-places.json');
  const brandPlaces = existsSync(bp) ? parseBrandTable(JSON.parse(readFileSync(bp, 'utf8')).brands ?? []).rows : [];
  return {
    category: c.category, keywords: c.keywords, relevanceTerms: c.relevanceTerms, brands: c.brands,
    excludePets: c.excludePets !== false, minDurationS: c.minDurationS ?? 30, maxPagesPerKeyword: c.maxPagesPerKeyword ?? 50,
    firstRunDays: 3, maxLookbackDays: 14, minAgeHours: 6, maxDeepPerRun: 150,
    secondModel: true, vision: true, maxFramesPerVideo: 30, deleteNonPromoAudio: true,
    placeDetect: true, brandPlaces,
    schedule: { enabled: false, frequency: 'daily', time: '03:00', weekday: 1 },
    reviewer: '',
  };
}

const NUMS = {
  minDurationS: [0, 3600, '最短时长（秒）'],
  maxPagesPerKeyword: [1, 50, '每个关键词最多翻页'],
  firstRunDays: [1, 14, '首次回溯天数'],
  maxLookbackDays: [1, 14, '最长回溯天数'],
  minAgeHours: [0, 72, '发布满几小时再处理'],
  maxDeepPerRun: [1, 2000, '每轮最多深度分析'],
  maxFramesPerVideo: [4, 200, '每条视频最多取帧'],
};
// 必填的只有搜索关键词（打开定时时还有时间）。品类词可以留空：划范围时改用搜索关键词（app/steps/scope.mjs），
// 空表不能直接拼正则——空的正则会匹配所有视频
const LISTS = { keywords: ['关键词', 1, 100], relevanceTerms: ['品类词', 0, 300], brands: ['品牌', 0, 500] };
const BOOLS = ['excludePets', 'secondModel', 'vision', 'deleteNonPromoAudio', 'placeDetect'];
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';
// 选填项留空（空串、空白、null）：数字和品类名称按默认值，不是 0 也不是原来的值
const blank = (v) => v === null || String(v).trim() === '';

// 校验并合并到 base 上：不合格的字段保留 base 的值，同时记下原因
export function validateSettings(input, base = defaultSettings()) {
  const errors = [];
  const out = structuredClone(base);
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return { settings: out, errors: ['设置格式不对'] };
  let defs;
  const dflt = (k) => (defs ??= defaultSettings())[k];
  if (input.category !== undefined) {
    const c = blank(input.category) ? dflt('category') : String(input.category).trim();
    if (c.length > 30) errors.push('品类名称不超过 30 个字');
    else out.category = c;
  }
  for (const [k, [label, min, max]] of Object.entries(LISTS)) {
    if (input[k] === undefined) continue;
    const raw = Array.isArray(input[k]) ? input[k] : String(input[k]).split(/[\n,，、;；]/);
    const list = [...new Set(raw.map((s) => String(s).trim()).filter(Boolean))];
    if (list.length < min) errors.push(`${label}至少要 ${min} 个`);
    else if (list.length > max) errors.push(`${label}最多 ${max} 个`);
    else if (list.some((s) => s.length > 40)) errors.push(`${label}每个不超过 40 个字`);
    else out[k] = list;
  }
  const defaulted = new Set();
  for (const [k, [min, max, label]] of Object.entries(NUMS)) {
    if (input[k] === undefined) continue;
    if (blank(input[k])) { out[k] = dflt(k); defaulted.add(k); continue; }
    const n = Number(input[k]);
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${label}要是 ${min}–${max} 之间的整数`);
    else out[k] = n;
  }
  for (const k of BOOLS) if (input[k] !== undefined) out[k] = truthy(input[k]);
  if (input.schedule !== undefined) {
    const s = input.schedule ?? {};
    const sch = { ...out.schedule };
    if (s.enabled !== undefined) sch.enabled = truthy(s.enabled);
    if (s.frequency !== undefined) {
      if (s.frequency === 'daily' || s.frequency === 'weekly') sch.frequency = s.frequency;
      else errors.push('频率只能是每天或每周');
    }
    if (s.time !== undefined) {
      if (blank(s.time)) { if (sch.enabled) errors.push('打开了定时就要填时间'); }   // 定时关着：留空就保留原来的时间
      else if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.time))) sch.time = String(s.time);
      else errors.push('时间要写成 HH:MM');
    }
    if (s.weekday !== undefined) {
      const w = Number(s.weekday);
      if (Number.isInteger(w) && w >= 0 && w <= 6) sch.weekday = w;
      else errors.push('星期要是 0–6');
    }
    out.schedule = sch;
  }
  if (input.reviewer !== undefined) {
    const r = String(input.reviewer).trim();
    if (r.length > 30) errors.push('复核人名字不超过 30 个字');
    else out.reviewer = r;
  }
  if (input.brandPlaces !== undefined) {
    const t = parseBrandTable(input.brandPlaces);
    if (t.errors.length) errors.push(...t.errors.slice(0, 5));
    else out.brandPlaces = t.rows;
  }
  // 第一轮回溯天数留空时按默认值，但不超过最长回溯天数（免得留空还报错）
  if (defaulted.has('firstRunDays')) out.firstRunDays = Math.min(out.firstRunDays, out.maxLookbackDays);
  if (out.firstRunDays > out.maxLookbackDays) errors.push('首次回溯天数不能大于最长回溯天数');
  return { settings: out, errors };
}

export function loadSettings(p) {
  const base = defaultSettings();
  if (!existsSync(p.settings)) return base;
  try {
    return validateSettings(JSON.parse(readFileSync(p.settings, 'utf8')), base).settings;
  } catch {
    return base;
  }
}

export function saveSettings(p, settings) {
  const tmp = `${p.settings}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 1));
  renameSync(tmp, p.settings);
}

// ── 运行锁：网页和命令行不能同时跑同一个工作区 ──
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
const LOCK_MAX_MS = 36 * 3600e3; // 进程号会被系统复用：锁超过 36 小时一律当作失效

export function acquireLock(p, runId) {
  const body = JSON.stringify({ pid: process.pid, runId, at: new Date().toISOString() });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(p.lock, body, { flag: 'wx' });
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(readFileSync(p.lock, 'utf8')); } catch { /* 锁文件坏了就当失效 */ }
      const stale = !holder || holder.pid === process.pid || !alive(holder.pid) || !(Date.now() - Date.parse(holder.at) < LOCK_MAX_MS);
      if (!stale) return { ok: false, holder };
      rmSync(p.lock, { force: true });
    }
  }
  return { ok: false, holder: null };
}

export function releaseLock(p) {
  try {
    const l = JSON.parse(readFileSync(p.lock, 'utf8'));
    if (l.pid === process.pid) rmSync(p.lock, { force: true });
  } catch { /* 没有锁就不用放 */ }
}

export function readLock(p) {
  try {
    const l = JSON.parse(readFileSync(p.lock, 'utf8'));
    return alive(l.pid) && Date.now() - Date.parse(l.at) < LOCK_MAX_MS ? l : null;
  } catch {
    return null;
  }
}

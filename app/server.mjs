// 自动监测网页：页面、接口、实时进度（SSE）、证据文件、定时器，都在这一个进程里。只监听 127.0.0.1。
// 用法：node --disable-warning=ExperimentalWarning app/server.mjs（npm run app），然后打开 http://127.0.0.1:8770/
// 安全：只认本机 Host（防 DNS 重绑定）；改动类请求必须是 JSON 且来源是本页（防别的网页借浏览器乱点）；文件只开放几个目录。
import './tz.mjs'; // 必须第一个导入：Git Bash 带的 TZ=UTC 要在算任何日期之前纠正
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, statfsSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';
import { ROOT } from '../src/db.mjs';
import { MODELS } from '../src/models.mjs';
import { LAW } from '../src/legal.mjs';
import { APP, tools, paths, openStore, loadSettings, saveSettings, validateSettings, defaultSettings, getMeta, setMeta, readLock } from './store.mjs';
import { findCommand, browserInstalled } from './lib/env.mjs';
import { STEPS, TRIGGERS, bus, currentRun, startRun, stopRun, markInterrupted, BusyError, computeSince } from './runner.mjs';
import { lastSlot, nextSlot, dueSlot } from './lib/schedule.mjs';
import { COMMERCIAL, FORMS, ATTENTION } from './lib/judge.mjs';
import { place, placeLabel, cityKey, parseLocationCsv, PLACE_ROLES, MUNICIPALITIES } from './lib/places.mjs';
import { listLeads, leadDetail, leadsCsv, refreshLead, locationTemplateCsv } from './leads.mjs';
import { collectQueue } from './steps/collect.mjs';

const PORT = Number(process.env.SAM_PORT || APP.port || 8770);
const p = paths();
const db = openStore(p);
const interrupted = markInterrupted(db, p);
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const count = (sql, ...a) => db.prepare(sql).get(...a).n;

// ── 状态 ──
function envCheck() {
  const t = tools();
  const python = findCommand(t.python), ffmpeg = findCommand(t.ffmpeg);
  const models = join(t.asrHome, 'models');
  const browser = browserInstalled(t.browserChannel);
  return [
    { id: 'ark', label: '方舟密钥', ok: !!process.env.ARK_API_KEY, hint: '环境变量 ARK_API_KEY（设好后要重启网页服务）' },
    { id: 'asr', label: '转写环境', ok: !!python && existsSync(join(models, 'sense-voice', 'model.int8.onnx')) && existsSync(join(models, 'silero_vad.onnx')), hint: `${python ?? `找不到 ${t.python}`}；模型在 ${models}` },
    { id: 'ffmpeg', label: 'ffmpeg', ok: !!ffmpeg, hint: ffmpeg ?? `找不到 ${t.ffmpeg}` },
    { id: 'edge', label: t.browserChannel === 'msedge' ? 'Edge 浏览器' : `浏览器（${t.browserChannel}）`, ok: browser !== false,
      hint: browser === null ? `没检查：频道 ${t.browserChannel}` : '本机浏览器，无头模式打开视频页' },
  ];
}

function runSummary(row) {
  if (!row) return null;
  const steps = new Map(db.prepare('SELECT * FROM run_steps WHERE run_id = ?').all(row.run_id).map((s) => [s.step, s]));
  return {
    runId: row.run_id, trigger: row.trigger, triggerName: TRIGGERS[row.trigger] ?? row.trigger, startedAt: row.started_at, finishedAt: row.finished_at,
    status: row.status, since: row.since, stats: parse(row.stats, {}), tokens: parse(row.tokens, {}), error: row.error,
    // 老的轮次没有后来新加的步骤：跑完了的显示「没跑」，不显示「等待」
    steps: STEPS.map((s) => ({ id: s.id, title: s.title, desc: s.desc, ...(steps.get(s.id) ?? { status: row.status === 'running' ? 'pending' : 'not-run' }), run_id: undefined, step: undefined })),
  };
}

function status() {
  const settings = loadSettings(p);
  const cur = currentRun();
  const lock = cur ? null : readLock(p);
  const runRow = cur || lock ? db.prepare('SELECT * FROM runs WHERE run_id = ?').get(cur?.runId ?? lock.runId) : db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1').get();
  let free = null;
  try { const s = statfsSync(p.root); free = s.bavail * s.bsize; } catch { /* 取不到就不显示 */ }
  const now = new Date();
  const sch = settings.schedule;
  return {
    now: now.toISOString(),
    running: cur ? { runId: cur.runId, external: false } : lock ? { runId: lock.runId, external: true, pid: lock.pid } : null,
    run: runSummary(runRow),
    schedule: { ...sch, next: sch.enabled ? nextSlot(now, sch).toISOString() : null, due: !!dueSlot(now, sch, getMeta(db, 'scheduleSlot')) },
    env: envCheck(),
    workspace: { root: p.root, free },
    queue: {
      comments: count(`SELECT COUNT(*) n FROM screening s LEFT JOIN comments c ON c.bvid = s.bvid WHERE s.in_scope = 1 AND c.bvid IS NULL`),
      collect: collectQueue(db).length,
      label: count(`SELECT COUNT(*) n FROM media m LEFT JOIN labels l ON l.bvid = m.bvid WHERE m.audio_ok = 1 AND (l.bvid IS NULL OR l.output IS NULL)`),
    },
    nextSince: computeSince(db, settings, Math.floor(now.getTime() / 1000)),
    interrupted,
  };
}

// 按地区统计线索（只算推广线索）：发布地、内容城市、品牌方所在地分开
function regionStats(promo) {
  const tally = (items) => {
    const m = new Map();
    for (const { key, label, pending } of items) { const x = m.get(key) ?? { label, n: 0, pending: 0 }; x.n++; if (pending) x.pending++; m.set(key, x); }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh')).slice(0, 12);
  };
  const each = (l, list) => [...new Map(list.filter((x) => x.city || x.province).map((x) => [cityKey(x), { key: cityKey(x), label: placeLabel(x), pending: l.status === '待复核' }])).values()];
  return {
    total: promo.length,
    pub: tally(promo.filter((l) => l.pub).map((l) => ({ key: cityKey(l.pub), label: placeLabel(l.pub), pending: l.status === '待复核' }))),
    pubUnknown: promo.filter((l) => !l.pub).length,
    content: tally(promo.flatMap((l) => each(l, l.region.content))),
    contentNone: promo.filter((l) => !l.region.content.length).length,
    brand: tally(promo.flatMap((l) => each(l, l.region.brand))),
    brandNone: promo.filter((l) => !l.region.brand.length).length,
  };
}

function overview() {
  const leads = listLeads(db);
  const promo = leads.filter((l) => l.promo);
  const tokens = { label: 0, second: 0, vision: 0, places: 0 };
  const runs = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 30').all();
  for (const r of db.prepare('SELECT tokens FROM runs').all()) for (const [k, v] of Object.entries(parse(r.tokens, {}))) tokens[k] = (tokens[k] ?? 0) + v;
  return {
    totals: {
      videos: count('SELECT COUNT(*) n FROM videos'),
      inScope: count('SELECT COUNT(*) n FROM screening WHERE in_scope = 1'),
      analyzed: count('SELECT COUNT(*) n FROM labels WHERE output IS NOT NULL'),
      promo: promo.length,
      pending: leads.filter((l) => l.status === '待复核').length,
      reviewed: leads.filter((l) => ['已确认', '已修改'].includes(l.status)).length,
      excluded: leads.filter((l) => l.status === '已排除').length,
      attention: leads.filter((l) => l.attention.length).length,
      A: promo.filter((l) => l.grade === 'A').length,
      B: promo.filter((l) => l.grade === 'B').length,
      undisclosed: promo.filter((l) => l.flags.some((f) => f.startsWith('未标明广告'))).length,
    },
    runs: runs.map((r) => ({ runId: r.run_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, trigger: TRIGGERS[r.trigger] ?? r.trigger, stats: parse(r.stats, {}), tokens: parse(r.tokens, {}) })),
    tokens,
    models: MODELS,
    regions: regionStats(promo),
  };
}

// ── 地区筛选：发布地（平台提供）和参考城市（内容里写的 / 品牌方所在地）分开 ──
// 发布地取值：none | P:省 | C:省/市；参考城市取值：none | content:P:省 | content:C:省/市 | brand:…
const inProv = (x, prov) => (x.province || '（省不详）') === prov;
function matchPub(l, v) {
  if (!v) return true;
  if (v === 'none') return !l.pub;
  if (!l.pub) return false;
  return v.startsWith('P:') ? inProv(l.pub, v.slice(2)) : cityKey(l.pub) === v;
}
function matchPlace(l, v) {
  if (!v) return true;
  if (v === 'none') return !l.region.content.length && !l.region.brand.length;
  const [kind, ...rest] = v.split(':');
  const key = rest.join(':');
  const list = kind === 'brand' ? l.region.brand : l.region.content;
  return list.some((x) => (key.startsWith('P:') ? inProv(x, key.slice(2)) : cityKey(x) === key));
}
function pubFacets(rows) {
  const provs = new Map();
  for (const l of rows) {
    if (!l.pub) continue;
    const pk = l.pub.province || '（省不详）';
    const pv = provs.get(pk) ?? { value: `P:${pk}`, name: pk, label: `${pk}（${MUNICIPALITIES.has(pk) ? '全市' : '全省'}）`, n: 0, cities: new Map() };
    pv.n++;
    if (l.pub.city && l.pub.city !== l.pub.province) {
      const ck = cityKey(l.pub);
      const c = pv.cities.get(ck) ?? { value: ck, label: placeLabel(l.pub), n: 0 };
      c.n++;
      pv.cities.set(ck, c);
    }
    provs.set(pk, pv);
  }
  return {
    none: rows.filter((l) => !l.pub).length,
    provinces: [...provs.values()].sort((a, b) => b.n - a.n).map((p) => ({ ...p, cities: [...p.cities.values()].sort((a, b) => b.n - a.n) })),
  };
}
function placeFacets(rows) {
  const group = (kind) => {
    const m = new Map();
    for (const l of rows) {
      for (const x of new Map(l.region[kind].map((y) => [cityKey(y), y])).values()) {
        const k = `${kind}:${cityKey(x)}`;
        const c = m.get(k) ?? { value: k, label: placeLabel(x), n: 0 };
        c.n++;
        m.set(k, c);
      }
    }
    return [...m.values()].sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, 'zh'));
  };
  return { none: rows.filter((l) => !l.region.content.length && !l.region.brand.length).length, content: group('content'), brand: group('brand') };
}

// ── 线索 ──
const VIEWS = {
  pending: (l) => l.status === '待复核',
  attention: (l) => l.attention.length > 0,
  reviewed: (l) => l.status === '已确认' || l.status === '已修改',
  excluded: (l) => l.status === '已排除',
  promo: (l) => l.promo,
  all: () => true,
};
function leadsApi(url) {
  const q = url.searchParams;
  const all = listLeads(db);
  const counts = Object.fromEntries(Object.entries(VIEWS).map(([k, f]) => [k, all.filter(f).length]));
  const view = VIEWS[q.get('view')] ? q.get('view') : 'pending';
  const grade = q.get('grade'), form = q.get('form'), att = q.get('attention'), text = (q.get('q') ?? '').trim().toLowerCase();
  const pub = q.get('pub') ?? '', plc = q.get('place') ?? '';
  const base = all.filter(VIEWS[view]).filter((l) => (!grade || l.grade === grade) && (!form || l.form === form)
    && (!att || l.attention.includes(att)) && (!text || `${l.title} ${l.author} ${l.bvid}`.toLowerCase().includes(text)));
  let rows = base.filter((l) => matchPub(l, pub) && matchPlace(l, plc));
  // 下拉框里的条数：别的筛选都算上，只放开自己这一栏（选哪一项就能看到几条）
  const facets = { pub: pubFacets(base.filter((l) => matchPlace(l, plc))), place: placeFacets(base.filter((l) => matchPub(l, pub))) };
  const sort = q.get('sort') ?? 'grade';
  const key = { grade: (l) => [l.grade, -l.play], play: (l) => [-l.play], date: (l) => [-l.pubdate], found: (l) => [-(Date.parse(l.labeledAt) || 0)] }[sort] ?? ((l) => [l.grade, -l.play]);
  rows.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
  const per = Math.min(200, Math.max(10, Number(q.get('per')) || 50));
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const page = Math.min(pages - 1, Math.max(0, Number(q.get('page')) || 0));
  return { total: rows.length, page, pages, per, counts, facets, rows: rows.slice(page * per, page * per + per) };
}

// 导入平台提供的发布地：CSV 文本（网页里读文件时已按 UTF-8 / GBK 解好）
function importLocations(input) {
  const { rows, errors } = parseLocationCsv(input?.text);
  const source = String(input?.source ?? '').trim().slice(0, 100) || '平台提供';
  const by = String(input?.by ?? '').trim().slice(0, 30);
  if (!rows.length) throw new HttpError(400, `没有能导入的行${errors.length ? `（${errors.slice(0, 3).map((e) => (e.line ? `第 ${e.line} 行：${e.msg}` : e.msg)).join('；')}）` : ''}`);
  const had = db.prepare('SELECT 1 FROM publish_locations WHERE bvid = ?');
  const known = db.prepare('SELECT 1 FROM videos WHERE bvid = ?');
  const put = db.prepare(`INSERT INTO publish_locations (bvid, province, city, source, note, updated_at, by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET province = excluded.province, city = excluded.city, source = excluded.source, note = excluded.note, updated_at = excluded.updated_at, by = excluded.by`);
  let updated = 0, unknown = 0;
  const at = new Date().toISOString();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (had.get(r.bvid)) updated++;
      if (!known.get(r.bvid)) unknown++;
      put.run(r.bvid, r.province, r.city, source, r.note, at, by);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { imported: rows.length, updated, unknown, errorCount: errors.length, errors: errors.slice(0, 20) };
}

function setLocation(bvid, input) {
  if (!db.prepare('SELECT 1 FROM videos WHERE bvid = ?').get(bvid)) throw new HttpError(404, '没有这条视频');
  const pl = place(input?.province, input?.city);
  if (!pl) throw new HttpError(400, '省和市至少填一个');
  if (pl.province.length > 12 || pl.city.length > 12) throw new HttpError(400, '省、市名字太长');
  const source = String(input?.source ?? '').trim().slice(0, 100) || '人工录入';
  db.prepare(`INSERT INTO publish_locations (bvid, province, city, source, note, updated_at, by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET province = excluded.province, city = excluded.city, source = excluded.source, note = excluded.note, updated_at = excluded.updated_at, by = excluded.by`)
    .run(bvid, pl.province, pl.city, source, String(input?.note ?? '').trim().slice(0, 200), new Date().toISOString(), String(input?.by ?? '').trim().slice(0, 30));
  return leadDetail(db, p, bvid);
}

async function reviewApi(bvid, input) {
  const lab = db.prepare('SELECT output, flags FROM labels WHERE bvid = ?').get(bvid);
  if (!lab?.output) throw new HttpError(404, '这条视频还没判定，没法复核');
  const verdict = input?.verdict;
  if (!['confirm', 'modify', 'reject'].includes(verdict)) throw new HttpError(400, '结论只能是确认、修改或不是推广');
  const flagTypes = new Set(parse(lab.flags, []).map((f) => f.type));
  const note = String(input.note ?? '').trim().slice(0, 1000);
  const reviewer = String(input.reviewer ?? '').trim();
  if (!reviewer) throw new HttpError(400, '请填复核人');
  if (reviewer.length > 30) throw new HttpError(400, '复核人名字不超过 30 个字');
  let commercial = null, form = null, removeFlags = [], frameDisclosed = false;
  if (verdict === 'modify') {
    commercial = input.commercial ?? null;
    form = input.form ?? null;
    if (commercial !== null && !['确定', '疑似'].includes(commercial)) throw new HttpError(400, '修改时商业关系只能是确定或疑似（不是推广请选「不是推广」）');
    if (form !== null && !FORMS.filter((f) => f !== '无').includes(form)) throw new HttpError(400, '推广形式不对');
    removeFlags = [...new Set((Array.isArray(input.removeFlags) ? input.removeFlags : []).map(String))];
    if (removeFlags.some((f) => !flagTypes.has(f))) throw new HttpError(400, '要去掉的问题不在这条线索里');
    frameDisclosed = input.frameDisclosed === true;
    const out = parse(lab.output);
    if (!commercial && !form && !removeFlags.length && !frameDisclosed) throw new HttpError(400, '选了「修改」但什么都没改；没问题请选「确认」');
    if (commercial === null && !COMMERCIAL.slice(0, 2).includes(out.commercial)) throw new HttpError(400, '模型判的是无推广：改成推广要选「确定」或「疑似」');
  }
  db.prepare(`INSERT OR REPLACE INTO reviews (bvid, reviewer, reviewed_at, verdict, commercial, form, remove_flags, frame_disclosed, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(bvid, reviewer, new Date().toISOString(), verdict, commercial, form, JSON.stringify(removeFlags), frameDisclosed ? 1 : 0, note);
  refreshLead(db, bvid, null, loadSettings(p));
  return leadDetail(db, p, bvid);
}

// ── 设置 ──
function settingsPayload() {
  const t = tools();
  return {
    settings: loadSettings(p), defaults: defaultSettings(), models: MODELS, law: LAW, attention: ATTENTION, placeRoles: PLACE_ROLES,
    workspace: p.root, app: { port: PORT, python: t.python, asrHome: t.asrHome, ffmpeg: findCommand(t.ffmpeg) ?? t.ffmpeg, browser: t.browserChannel, asrShards: APP.asrShards ?? 3, asrThreads: APP.asrThreads ?? 4 },
    researchSite: existsSync(join(ROOT, 'site', 'index.html')), // 研究版报告在不在（开源版不带）
  };
}
function putSettings(input) {
  const before = loadSettings(p);
  const { settings, errors } = validateSettings(input, before);
  if (errors.length) throw new HttpError(400, errors.join('；'));
  saveSettings(p, settings);
  // 打开或改动定时：把「最近一个应跑时刻」记为已处理，下一次到点才跑（免得一打开就立刻跑一轮）
  if (JSON.stringify(settings.schedule) !== JSON.stringify(before.schedule)) setMeta(db, 'scheduleSlot', lastSlot(new Date(), settings.schedule).toISOString());
  // 品牌方所在地对照表改了：所有线索重新对一遍（只查库，很快）
  if (JSON.stringify(settings.brandPlaces) !== JSON.stringify(before.brandPlaces)) {
    for (const { bvid } of db.prepare('SELECT bvid FROM labels WHERE output IS NOT NULL').all()) refreshLead(db, bvid, null, settings);
  }
  return settingsPayload();
}

// ── 文件 ──
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
function sendFile(req, res, base, rel, allowExt) {
  const clean = normalize(decodeURIComponent(rel)).replace(/^[\\/]+/, '');
  const file = join(base, clean);
  if (!file.startsWith(base + sep) || (allowExt && !allowExt.includes(extname(file).toLowerCase()))) throw new HttpError(403, 'forbidden');
  let st;
  try { st = statSync(file); } catch { throw new HttpError(404, 'not found'); }
  if (!st.isFile()) throw new HttpError(404, 'not found');
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  createReadStream(file).pipe(res);
}

// ── 请求处理 ──
const json = (res, code, obj) => { const s = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); };
async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new HttpError(413, '请求太大'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'JSON 格式不对'); }
}

function stream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 3000\n\n');
  const send = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { bus.off('event', send); clearInterval(ping); });
}

async function handle(req, res) {
  if (!HOSTS.has(req.headers.host ?? '')) throw new HttpError(403, 'bad host');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.headers.origin && !ORIGINS.has(req.headers.origin)) throw new HttpError(403, 'bad origin');
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '要用 JSON 提交');
  }
  let m;
  if (method === 'GET' && path === '/') return sendFile(req, res, join(ROOT, 'app', 'ui'), 'index.html');
  if (method === 'GET' && (m = path.match(/^\/ui\/(.+)$/))) return sendFile(req, res, join(ROOT, 'app', 'ui'), m[1], ['.html', '.js', '.css', '.svg']);
  // 研究版网站（样式、脚本、报告）和它引用的数据，只读
  if (method === 'GET' && (m = path.match(/^\/(site|data)\/(.+)$/))) return sendFile(req, res, join(ROOT, m[1]), m[2]);
  if (method === 'GET' && (m = path.match(/^\/ws\/((?:audio|frames|evidence)\/.+)$/))) return sendFile(req, res, p.root, m[1], ['.m4a', '.jpg', '.png']);

  if (path === '/api/stream' && method === 'GET') return stream(req, res);
  if (path === '/api/status' && method === 'GET') return json(res, 200, status());
  if (path === '/api/overview' && method === 'GET') return json(res, 200, overview());
  if (path === '/api/runs' && method === 'POST') {
    await readBody(req);
    try {
      const { runId, promise } = startRun({ trigger: 'manual' });
      promise.catch((e) => console.error('运行出错：', e));
      return json(res, 202, { runId });
    } catch (e) {
      if (e instanceof BusyError) throw new HttpError(409, e.message);
      throw e;
    }
  }
  if (path === '/api/runs/stop' && method === 'POST') { await readBody(req); return json(res, 200, { stopped: stopRun() }); }
  if (path === '/api/runs' && method === 'GET') {
    return json(res, 200, db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 200').all().map((r) => ({
      runId: r.run_id, trigger: TRIGGERS[r.trigger] ?? r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, stats: parse(r.stats, {}), tokens: parse(r.tokens, {}), error: r.error,
    })));
  }
  if ((m = path.match(/^\/api\/runs\/(run-[\d-]+)$/)) && method === 'GET') {
    const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(m[1]);
    if (!row) throw new HttpError(404, '没有这一轮');
    return json(res, 200, { ...runSummary(row), settings: parse(row.settings, {}), events: db.prepare('SELECT id, ts, level, step, msg FROM events WHERE run_id = ? ORDER BY id').all(m[1]) });
  }
  if (path === '/api/leads' && method === 'GET') return json(res, 200, leadsApi(url));
  if ((m = path.match(/^\/api\/leads\/(BV[0-9A-Za-z]{10})$/)) && method === 'GET') {
    const d = leadDetail(db, p, m[1]);
    if (!d) throw new HttpError(404, '没有这条视频');
    return json(res, 200, d);
  }
  if ((m = path.match(/^\/api\/leads\/(BV[0-9A-Za-z]{10})\/review$/))) {
    if (method === 'POST') return json(res, 200, await reviewApi(m[1], await readBody(req)));
    if (method === 'DELETE') {
      await readBody(req);
      db.prepare('DELETE FROM reviews WHERE bvid = ?').run(m[1]);
      refreshLead(db, m[1], null, loadSettings(p));
      const d = leadDetail(db, p, m[1]);
      if (!d) throw new HttpError(404, '没有这条视频');
      return json(res, 200, d);
    }
  }
  // 发布地：单条录入 / 清除；批量导入；导出待查清单
  if ((m = path.match(/^\/api\/leads\/(BV[0-9A-Za-z]{10})\/location$/))) {
    if (method === 'PUT') return json(res, 200, setLocation(m[1], await readBody(req)));
    if (method === 'DELETE') {
      await readBody(req);
      db.prepare('DELETE FROM publish_locations WHERE bvid = ?').run(m[1]);
      const d = leadDetail(db, p, m[1]);
      if (!d) throw new HttpError(404, '没有这条视频');
      return json(res, 200, d);
    }
  }
  if (path === '/api/locations/import' && method === 'POST') return json(res, 200, importLocations(await readBody(req, 8_000_000)));
  if (path === '/api/locations/template.csv' && method === 'GET') {
    const d = new Date();
    const name = `待查发布地-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
    return res.end(locationTemplateCsv(db));
  }
  if (path === '/api/settings' && method === 'GET') return json(res, 200, settingsPayload());
  if (path === '/api/settings' && method === 'PUT') return json(res, 200, putSettings(await readBody(req)));
  if (path === '/api/export/leads.csv' && method === 'GET') {
    const d = new Date();
    const name = `软广线索-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
    const body = leadsCsv(db);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Cache-Control': 'no-store' });
    return res.end(body);
  }
  throw new HttpError(404, 'not found');
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500) console.error(e);
    if (res.headersSent) { res.end(); return; }
    if (req.url.startsWith('/api/')) json(res, code, { error: e.message });
    else { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(e.message); }
  });
});

// ── 定时：每 30 秒看一次有没有到点 ──
function tick() {
  try {
    const s = loadSettings(p);
    const slot = dueSlot(new Date(), s.schedule, getMeta(db, 'scheduleSlot'));
    if (!slot || currentRun()) return;
    setMeta(db, 'scheduleSlot', slot.toISOString());
    if (readLock(p)) { console.log('到点了，但命令行那边正在跑，这次不重复跑'); return; }
    const { promise } = startRun({ trigger: 'schedule' });
    promise.catch((e) => console.error('定时运行出错：', e));
  } catch (e) {
    console.error('定时检查出错：', e.message);
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用：网页服务可能已经开着，直接打开 http://127.0.0.1:${PORT}/ 就行`);
  else console.error(e);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`自动监测网页：http://127.0.0.1:${PORT}/`);
  console.log(`工作区：${p.root}`);
  if (interrupted) console.log(`上次有 ${interrupted} 轮没跑完就退出了，已标成「中断」；下一轮会接着处理没做完的视频`);
  // 自检脚本（app/check.mjs）起的临时服务不带定时器，免得替正式服务跑一轮
  if (process.env.SAM_NO_SCHEDULE) return;
  setTimeout(tick, 5000);
  setInterval(tick, 30_000);
});

// Ctrl+C：先停掉正在跑的一轮（最多等 20 秒），再退出
let closing = false;
process.on('SIGINT', async () => {
  if (closing) process.exit(1);
  closing = true;
  const cur = currentRun();
  if (cur) {
    console.log('正在停止当前这一轮…');
    stopRun();
    await Promise.race([cur.promise.catch(() => {}), new Promise((r) => setTimeout(r, 20000))]);
  }
  process.exit(0);
});

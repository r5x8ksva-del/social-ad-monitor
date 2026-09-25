/* 自动监测网页：概览（运行面板、步骤进度、数字卡、每轮新线索、日志）、线索（列表 + 证据抽屉 + 复核）、运行记录、设置。
   数据里的文字一律走 textContent（SAM.h）。实时进度走 /api/stream（SSE）；命令行在跑的时候收不到推送，改成每 5 秒查一次。 */
(function () {
  'use strict';
  const { h, int, mmss, toSec, lightbox, withTip, commercialBadge, disclosureBadge, gradeBadge, biliUrl } = window.SAM;
  // 研究版的 disclosureBadge 只认三档；自动监测多一档「声明含营销信息」（B站 创作者声明，2026-05 起），和「只提到赞助合作」一样仍算未标明广告
  const discBadge = (d, isPromo) => (isPromo && d === '声明含营销信息' ? h('span', { class: 'badge b-crit', text: '只声明含营销信息' }) : disclosureBadge(d, isPromo));
  const C = window.CHARTS;
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  let cleanups = [];
  const onLeave = (f) => cleanups.push(f);

  // ── 接口 ──
  async function api(path, { method = 'GET', body } = {}) {
    const opts = { method, headers: {} };
    if (method !== 'GET') { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body ?? {}); }
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  let toastTimer;
  function toast(msg, err = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('err', err);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), err ? 6000 : 2600);
  }

  // ── 格式 ──
  const pad = (n) => String(n).padStart(2, '0');
  const toDate = (v) => (v == null ? null : new Date(typeof v === 'number' ? v * 1000 : v));
  const dt = (v) => { const d = toDate(v); return !d || Number.isNaN(d.getTime()) ? '—' : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const ymd = (v) => { const d = toDate(v); return !d || Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dur = (sec) => (sec == null || Number.isNaN(sec) ? '—' : sec < 60 ? `${Math.max(0, Math.round(sec))} 秒` : sec < 3600 ? `${Math.round(sec / 60)} 分钟` : `${Math.floor(sec / 3600)} 小时 ${Math.round((sec % 3600) / 60)} 分`);
  const compact = (n) => (n == null ? '—' : n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万` : int(n));
  const gb = (b) => (b == null ? '' : `${(b / 2 ** 30).toFixed(b > 100 * 2 ** 30 ? 0 : 1)} GB`);
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const freqText = (s) => (s.frequency === 'weekly' ? `每${WEEK[s.weekday]} ${s.time}` : `每天 ${s.time}`);

  const ST = {
    running: ['进行中', 'st-run', '●'], done: ['完成', 'st-good', '✓'], partial: ['跑完，有步骤出错', 'st-crit', '!'],
    blocked: ['被 B站 限制', 'st-crit', '!'], failed: ['出错', 'st-crit', '✕'], stopped: ['已停止', 'st-warn', '■'],
    interrupted: ['中断', 'st-warn', '■'], skipped: ['跳过', 'st-mute', '–'], pending: ['等待', 'st-mute', '○'], 'not-run': ['没跑', 'st-mute', '–'],
  };
  const stBadge = (s, label) => { const [txt, cls, icon] = ST[s] ?? [s, 'st-mute', '?']; return h('span', { class: `st ${cls}` }, h('i', { 'aria-hidden': 'true', text: icon }), label ?? txt); };
  const LEAD_ST = { 待复核: ['st-warn', '?'], 已确认: ['st-good', '✓'], 已修改: ['st-good', '✓'], 已排除: ['st-mute', '–'], 无推广: ['st-mute', '–'] };
  const leadBadge = (s) => { const [cls, icon] = LEAD_ST[s] ?? ['st-mute', '?']; return h('span', { class: `st ${cls}` }, h('i', { 'aria-hidden': 'true', text: icon }), s); };
  const ATT_SHORT = { 两模型分歧: '两模型分歧', 原话核对不上: '原话对不上', 画面疑似写了广告: '画面有广告字样', 画面有不能代替药物字样: '画面有药物声明', 画面有保健食品标志: '画面有保健食品', 有画面没读出来: '有帧没读出' };
  const attBadges = (list) => (list?.length ? h('span', { class: 'att' }, list.map((a) => h('span', { class: 'badge b-att', text: ATT_SHORT[a] ?? a, title: a }))) : '—');
  const ws = (file) => `/ws/${String(file).split('/').map(encodeURIComponent).join('/')}`;
  const head = (title, text, ...actions) => h('div', { class: 'page-head' }, h('h1', { text: title }), text ? h('p', { text }) : null, actions.length ? h('div', { class: 'actions' }, actions) : null);
  const secH = (title, sub) => h('h2', { class: 'sec-h' }, title, sub ? h('span', { class: 'sub', text: sub }) : null);
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]));
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', text });

  let meta = { attention: {}, law: {}, reviewer: '' };
  const savedReviewer = () => { try { return localStorage.getItem('sam-reviewer') || meta.reviewer || ''; } catch { return meta.reviewer || ''; } };
  const saveReviewer = (name) => { try { localStorage.setItem('sam-reviewer', name); } catch { /* 存不了就算了 */ } };

  // ── 实时推送 ──
  const listeners = new Set();
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (m) => { let e; try { e = JSON.parse(m.data); } catch { return; } for (const f of [...listeners]) f(e); };
    es.onopen = () => { for (const f of [...listeners]) f({ type: 'reconnect' }); };
  }
  const onEvent = (f) => { listeners.add(f); onLeave(() => listeners.delete(f)); };
  listeners.add((e) => { if (e.type === 'run' || e.type === 'reconnect') refreshNav(); });

  async function refreshNav() {
    try {
      const d = await api('/api/leads?view=pending&per=10');
      const b = $('nav-pending');
      b.hidden = !d.counts.pending;
      b.textContent = String(d.counts.pending);
      b.setAttribute('aria-label', `${d.counts.pending} 条待复核`);
    } catch { /* 下次再更新 */ }
  }

  // ── 路由 ──
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const [page = '', arg] = path.split('/');
    return { page, arg: arg ? decodeURIComponent(arg) : null, query: Object.fromEntries(new URLSearchParams(qs ?? '')) };
  }
  async function route() {
    for (const f of cleanups.splice(0)) { try { f(); } catch { /* 忽略 */ } }
    const { page, arg, query } = parseHash();
    const key = { '': 'overview', leads: 'leads', runs: 'runs', settings: 'settings' }[page] ?? 'overview';
    for (const a of document.querySelectorAll('[data-nav]')) { if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    const render = { overview, leads: () => leadsPage(arg, query), runs: () => (arg ? runDetail(arg) : runsPage()), settings: settingsPage }[key];
    try {
      await render();
    } catch (e) {
      view.replaceChildren(head('出错了', ''), h('p', { class: 'callout warn', text: `页面没加载出来：${e.message}` }));
    }
  }
  window.addEventListener('hashchange', () => { if (!/^#\/leads\/BV/.test(location.hash) || drawer.hidden) route(); });

  // ── 步骤列表（概览和运行详情共用） ──
  function stepRow(s, i) {
    const running = s.status === 'running';
    const pct = s.total > 0 ? Math.min(100, Math.round((s.done / s.total) * 100)) : null;
    const meter = running ? h('div', { class: `meter${pct == null ? ' busy' : ''}`, role: 'progressbar', 'aria-label': `${s.title}的进度`, 'aria-valuemin': '0', 'aria-valuemax': String(s.total || 100), 'aria-valuenow': String(s.done || 0) }, h('i', { style: `width:${pct ?? 30}%` })) : null;
    const counts = s.total > 0 ? `${int(s.done)} / ${int(s.total)}` : '';
    const bad = s.status === 'failed' || s.status === 'blocked';
    const took = s.started_at && s.finished_at ? dur((Date.parse(s.finished_at) - Date.parse(s.started_at)) / 1000) : running && s.started_at ? dur((Date.now() - Date.parse(s.started_at)) / 1000) : '';
    return h('li', { class: s.status, dataset: { step: s.id } },
      h('span', { class: 'no', text: pad(i + 1) }),
      h('span', { class: 't' }, h('b', { text: s.title }), h('span', { text: s.desc ?? '' })),
      stBadge(s.status),
      h('span', { class: 'prog' }, meter, counts ? h('span', { text: counts }) : null, s.note ? h('span', { class: `note${bad ? ' err' : ''}`, title: s.note, text: s.note }) : null),
      h('span', { class: 'dur', text: took }));
  }
  function stepsList(run) {
    const ol = h('ol', { class: 'steps-live', 'aria-label': '步骤' });
    const steps = run?.steps ?? [];
    steps.forEach((s, i) => ol.appendChild(stepRow(s, i)));
    // 推送来的步骤更新：只换那一行
    ol.update = (e) => {
      const i = steps.findIndex((s) => s.id === e.step);
      if (i < 0) return;
      steps[i] = { ...steps[i], ...e, id: steps[i].id, title: steps[i].title, desc: steps[i].desc };
      const old = ol.querySelector(`li[data-step="${e.step}"]`);
      if (old) old.replaceWith(stepRow(steps[i], i));
    };
    ol.steps = steps;
    return ol;
  }

  function logLine(e, stepTitles) {
    const lv = e.level === 'error' ? '✕' : e.level === 'warn' ? '!' : '·';
    const t = toDate(e.ts);
    return h('div', { class: e.level },
      h('span', { class: 'ts', text: `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}` }),
      h('span', { class: 'lv', text: lv, 'aria-label': e.level === 'error' ? '出错' : e.level === 'warn' ? '提醒' : '' }),
      h('span', { class: 'msg' }, e.step ? h('span', { class: 'lg-step', text: `[${stepTitles[e.step] ?? e.step}] ` }) : null, e.msg));
  }

  // ── 概览 ──
  async function overview() {
    const [st, ov] = await Promise.all([api('/api/status'), api('/api/overview')]);
    const run = st.run;
    const titles = Object.fromEntries((run?.steps ?? []).map((s) => [s.id, s.title]));
    const steps = stepsList(run);
    const logBox = h('div', { class: 'logbox', role: 'log', 'aria-live': 'polite', 'aria-label': '运行日志' });
    view.replaceChildren(
      head('自动监测', '每一轮：找新视频 → 评论区与初筛 → 采集和转写 → 两个模型判定 → 取帧读字 → 识别地区 → 汇总线索。机器把这些步骤全部跑完，线索标「待复核」，由人在「线索」页确认。'),
      runPanel(st),
      secH(st.running ? '这一轮' : '上一轮', run ? `${dt(run.startedAt)} 开始 · ${run.triggerName}` : ''),
      run ? steps : h('p', { class: 'empty', text: '还没跑过。点上面的「立即运行」开始第一轮。' }),
      secH('线索'),
      kpis(ov, st),
      h('div', { style: 'height:16px' }),
      runsChart(ov.runs),
      secH('线索按地区', '只算推广线索；发布地要平台提供，另外两栏是参考'),
      regionTables(ov.regions),
      secH('日志', run ? '最近一轮，最新的在最下面' : ''),
      logBox,
    );
    if (run) {
      const d = await api(`/api/runs/${run.runId}`);
      const lines = d.events.slice(-300);
      logBox.replaceChildren(...(lines.length ? lines.map((e) => logLine(e, titles)) : [h('span', { class: 'muted', text: '还没有日志' })]));
      logBox.scrollTop = logBox.scrollHeight;
    } else {
      logBox.replaceChildren(h('span', { class: 'muted', text: '还没有日志' }));
    }
    let reloadTimer = null;
    const reload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => { if (parseHash().page === '') route(); }, 300); };
    onLeave(() => clearTimeout(reloadTimer));
    onEvent((e) => {
      if (e.type === 'run' || e.type === 'reconnect') return reload();
      if (!run || e.runId !== run.runId) return;
      if (e.type === 'step') steps.update(e);
      if (e.type === 'log') {
        const stick = logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 30;
        logBox.querySelector('.muted')?.remove();
        logBox.appendChild(logLine(e, titles));
        while (logBox.childElementCount > 400) logBox.firstElementChild.remove();
        if (stick) logBox.scrollTop = logBox.scrollHeight;
      }
    });
    // 命令行在跑：收不到推送，每 5 秒刷新一次；自己在跑：每 30 秒刷新一次用时
    const iv = setInterval(() => { if (st.running?.external) route(); else if (st.running) steps.querySelectorAll('li.running').forEach((li) => steps.update({ step: li.dataset.step })); }, st.running?.external ? 5000 : 30000);
    onLeave(() => clearInterval(iv));
  }

  function runPanel(st) {
    const r = st.run, running = st.running;
    const envBad = st.env.filter((e) => !e.ok);
    const cur = running && r ? r.steps.findIndex((s) => s.status === 'running') : -1;
    const state = h('div', { class: 'rp-state' });
    if (running) state.append(stBadge('running', running.external ? '命令行正在跑' : '正在运行'), cur >= 0 ? `第 ${cur + 1} 步：${r.steps[cur].title}` : '准备中');
    else if (r) state.append(stBadge(r.status), `上一轮 ${dt(r.finishedAt ?? r.startedAt)} 结束`);
    else state.append('还没跑过');
    const subs = [];
    if (r) subs.push(`开始于 ${dt(r.startedAt)}（${r.triggerName}）· ${running ? `已经跑了 ${dur((Date.now() - Date.parse(r.startedAt)) / 1000)}` : `用时 ${dur(r.stats?.seconds)}`} · 找 ${dt(r.since)} 以后发布的视频`);
    if (!running) subs.push(`下一轮会找 ${dt(st.nextSince)} 以后发布的视频${st.queue.collect ? `；还有 ${int(st.queue.collect)} 条范围内的视频排队等深度分析` : ''}`);
    const sch = st.schedule;
    const schLine = h('p', { class: 'rp-sub' }, sch.enabled ? `定时：${freqText(sch)}，下一次 ${dt(sch.next)}${sch.due ? '（到点了，马上开始）' : ''}。网页服务开着才会到点运行。` : '定时没开，只在点「立即运行」时跑。', ' ', h('a', { href: '#/settings', text: sch.enabled ? '改定时' : '打开定时' }));
    const runBtn = h('button', { class: 'btn', type: 'button', text: '立即运行', disabled: !!running || envBad.some((e) => e.id === 'ark') });
    const stopBtn = h('button', { class: 'btn ghost', type: 'button', text: '停止', disabled: !running || running.external });
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      try { await api('/api/runs', { method: 'POST' }); toast('开始运行了'); } catch (e) { toast(e.message, true); runBtn.disabled = false; }
    });
    stopBtn.addEventListener('click', async () => {
      if (!confirm('停止这一轮？已经做完的部分都会保留，下一轮接着做没做完的。')) return;
      stopBtn.disabled = true;
      try { await api('/api/runs/stop', { method: 'POST' }); toast('正在停止…'); } catch (e) { toast(e.message, true); stopBtn.disabled = false; }
    });
    const env = h('ul', { class: 'env', 'aria-label': '运行环境' },
      st.env.map((e) => h('li', { title: e.hint }, stBadge(e.ok ? 'done' : 'failed', e.label))),
      h('li', { class: 'ws' }, `工作区 ${st.workspace.root}${st.workspace.free != null ? ` · 剩余 ${gb(st.workspace.free)}` : ''}`));
    return h('section', { class: 'run-panel', 'aria-label': '运行' },
      h('div', { class: 'rp-main' }, state, subs.map((t) => h('p', { class: 'rp-sub', text: t })), schLine,
        !running && r?.error && r.status !== 'done' ? h('p', { class: 'callout warn', text: r.error }) : null,
        envBad.length ? h('p', { class: 'callout warn', text: `缺运行环境：${envBad.map((e) => `${e.label}（${e.hint}）`).join('；')}` }) : null,
        st.interrupted ? h('p', { class: 'rp-sub muted', text: `网页服务上次退出时有 ${st.interrupted} 轮没跑完，已标为「中断」；没做完的视频下一轮会接着处理。` }) : null),
      h('div', { class: 'rp-actions' }, runBtn, stopBtn),
      env);
  }

  function kpis(ov, st) {
    const t = ov.totals;
    const tokens = (ov.tokens.label ?? 0) + (ov.tokens.second ?? 0) + (ov.tokens.vision ?? 0) + (ov.tokens.places ?? 0);
    const tile = (label, value, sub, href, hot) => h(href ? 'a' : 'div', { class: `kpi${hot ? ' hot' : ''}`, href }, h('span', { class: 'l', text: label }), h('span', { class: 'v', text: compact(value) }), h('span', { class: 's', text: sub }));
    return h('div', { class: 'kpis' },
      tile('待复核', t.pending, `累计线索 ${int(t.promo)} 条，已复核 ${int(t.reviewed)}`, '#/leads?view=pending', t.pending > 0),
      tile('A 级线索', t.A, '确定推广，且挂购物链接或有其他疑似问题', '#/leads?view=promo&grade=A'),
      tile('B 级线索', t.B, '其余推广（疑似，或确定但没链接）', '#/leads?view=promo&grade=B'),
      tile('需要注意', t.attention, '模型分歧、原话对不上、画面有字样等', '#/leads?view=attention'),
      tile('排队待分析', st.queue.collect, `已深度分析 ${int(t.analyzed)} 条 · 范围内 ${int(t.inScope)} 条`),
      tile('大模型用量', tokens, `token，判定 ${compact(ov.tokens.label)} · 交叉 ${compact(ov.tokens.second)} · 读画面 ${compact(ov.tokens.vision)} · 认地区 ${compact(ov.tokens.places ?? 0)}`));
  }

  // 每轮新增线索：一个系列，柱子用 --series-1；只标最新一轮的数，其余悬停或看表格
  function runsChart(runs) {
    const done = runs.filter((r) => r.status !== 'running' && r.stats && r.stats.leadsNew != null).reverse();
    if (done.length < 2) return h('p', { class: 'empty', text: '跑满两轮后，这里会显示每轮新增线索的变化。' });
    const max = Math.max(1, ...done.map((r) => r.stats.leadsNew));
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find((s) => s * 2 >= max) ?? Math.ceil(max / 2);
    const top = step * 2;
    const plot = h('div', { class: 'colchart', role: 'img', 'aria-label': `最近 ${done.length} 轮的新增线索数，最新一轮 ${done.at(-1).stats.leadsNew} 条` },
      [0, step, top].map((v) => h('div', { class: 'grid-l', style: `bottom:${(v / top) * 100}%` }, h('span', { text: String(v) }))),
      h('div', { class: 'base' }),
      h('div', { class: 'cols' }, done.map((r, i) => {
        const v = r.stats.leadsNew, pct = (v / top) * 100;
        const col = h('div', { class: 'col' }, h('i', { style: `height:${pct}%` }), i === done.length - 1 ? h('b', { style: `bottom:${pct}%`, text: String(v) }) : null);
        return withTip(col, [`${v} 条新线索`, `${dt(r.startedAt)}（${r.trigger}）`, `深度分析 ${int(r.stats.labeled ?? 0)} 条 · A 级 ${int(r.stats.leadsNewA ?? 0)} / B 级 ${int(r.stats.leadsNewB ?? 0)}`]);
      })));
    const x = h('div', { class: 'colchart-x' }, h('span', { text: ymd(done[0].startedAt) }), h('span', { text: ymd(done.at(-1).startedAt) }));
    const table = h('div', { class: 'alt', hidden: true }, h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, h('th', { text: '开始' }), h('th', { class: 'n', text: '深度分析' }), h('th', { class: 'n', text: '新线索' }), h('th', { class: 'n', text: 'A 级' }), h('th', { class: 'n', text: 'B 级' }))),
      h('tbody', null, [...done].reverse().map((r) => h('tr', null, h('td', { text: `${dt(r.startedAt)}（${r.trigger}）` }), h('td', { class: 'n', text: int(r.stats.labeled ?? 0) }), h('td', { class: 'n', text: int(r.stats.leadsNew) }), h('td', { class: 'n', text: int(r.stats.leadsNewA ?? 0) }), h('td', { class: 'n', text: int(r.stats.leadsNewB ?? 0) })))))));
    const toggle = h('button', { class: 'tbl-toggle', type: 'button', text: '看表格', 'aria-expanded': 'false' });
    toggle.addEventListener('click', () => { table.hidden = !table.hidden; toggle.textContent = table.hidden ? '看表格' : '收起表格'; toggle.setAttribute('aria-expanded', String(!table.hidden)); });
    return h('figure', { class: 'chart', style: 'margin:0' }, h('h4', { text: '每轮新增线索' }), h('p', { class: 'cap', text: `最近 ${done.length} 轮，悬停或用 Tab 键看每轮的详情` }), plot, x, h('div', { class: 'chart-foot' }, h('span'), toggle), table);
  }

  // ── 线索 ──
  const VIEW_NAMES = [['pending', '待复核'], ['attention', '需要注意'], ['reviewed', '已复核'], ['excluded', '已排除'], ['promo', '全部推广'], ['all', '全部判定过的']];
  const FORMS = ['中插', '全片定制', '挂链测评', '评论区带货', '自家推广'];
  const leadState = { view: 'pending', q: '', grade: '', form: '', attention: '', pub: '', place: '', sort: 'grade', page: 0 };

  // ── 地区显示：发布地（平台提供）和参考城市（内容里写的 / 品牌方所在地）分开 ──
  const placeLabel = (x) => (!x ? '' : x.city && x.province && x.city !== x.province ? `${x.province}·${x.city}` : x.city || x.province);
  const pubCell = (pub) => (pub ? h('span', { title: `来源：${pub.source || '—'}` }, placeLabel(pub)) : h('span', { class: 'muted', text: '未知' }));
  function refCell(region) {
    const items = [
      ...region.content.map((x) => h('span', { class: 'badge b-soft', title: `内容里写到（${x.role}）` }, `内容 ${placeLabel(x)}`)),
      ...region.brand.map((x) => h('span', { class: 'badge b-soft', title: `${x.brand}${x.company ? ` · ${x.company}` : ''}` }, `品牌方 ${placeLabel(x)}`)),
    ];
    return items.length ? h('span', { class: 'att' }, items.slice(0, 3), items.length > 3 ? h('span', { class: 'muted', text: `+${items.length - 3}` }) : null) : '—';
  }
  // 下拉框：按省分组；每项带条数
  function pubOptions(f) {
    return [h('option', { value: '', text: '发布地：全部' }), h('option', { value: 'none', text: `发布地未知（${int(f.none)}）` }),
      ...f.provinces.map((pv) => h('optgroup', { label: pv.name }, h('option', { value: pv.value, text: `${pv.label}（${int(pv.n)}）` }), pv.cities.map((c) => h('option', { value: c.value, text: `${c.label}（${int(c.n)}）` }))))];
  }
  function placeOptions(f) {
    return [h('option', { value: '', text: '参考城市：全部' }), h('option', { value: 'none', text: `没认出城市（${int(f.none)}）` }),
      f.content.length ? h('optgroup', { label: '内容里写到的城市' }, f.content.map((c) => h('option', { value: c.value, text: `${c.label}（${int(c.n)}）` }))) : null,
      f.brand.length ? h('optgroup', { label: '品牌方所在地（对照表）' }, f.brand.map((c) => h('option', { value: c.value, text: `${c.label}（${int(c.n)}）` }))) : null];
  }

  // 读用户选的表格文件：先按 UTF-8 解，不是就按 GBK（Excel 另存的中文 CSV 常是 GBK）
  async function readTextFile(file) {
    const buf = await file.arrayBuffer();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('gbk').decode(buf); }
  }

  function importPanel(onDone) {
    const fileIn = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', 'aria-label': '选择表格文件' });
    const text = h('textarea', { rows: '5', placeholder: '把平台给的表格粘贴在这里，或者在上面选文件。\n每行：BV 号, 省, 市（可以带表头；也可以只有一列「发布地」，如「广东 广州」）', 'aria-label': '发布地表格内容' });
    const source = h('input', { type: 'text', value: '平台依法提供', maxlength: '100', 'aria-label': '数据来源' });
    const msg = h('div', { class: 'imp-msg', role: 'status' });
    const go = h('button', { class: 'btn small', type: 'button', text: '导入' });
    fileIn.addEventListener('change', async () => { if (fileIn.files[0]) text.value = await readTextFile(fileIn.files[0]); });
    go.addEventListener('click', async () => {
      msg.textContent = '';
      if (!text.value.trim()) { msg.textContent = '先选文件或粘贴表格'; return; }
      go.disabled = true;
      try {
        const r = await api('/api/locations/import', { method: 'POST', body: { text: text.value, source: source.value, by: savedReviewer() } });
        msg.textContent = `导入 ${int(r.imported)} 条（其中更新 ${int(r.updated)} 条${r.unknown ? `，${int(r.unknown)} 条不在监测数据里，先存着` : ''}）${r.errorCount ? `；${int(r.errorCount)} 行没导入：${r.errors.slice(0, 3).map((e) => `第 ${e.line} 行：${e.msg}`).join('；')}${r.errorCount > 3 ? ' …' : ''}` : ''}`;
        toast('发布地已导入');
        onDone();
      } catch (e) { msg.textContent = e.message; }
      go.disabled = false;
    });
    return h('div', { class: 'imp card', hidden: true },
      h('h4', { text: '导入平台提供的发布地' }),
      h('p', { class: 'muted', style: 'font-size:13px;margin:0 0 10px', text: 'B站 游客看不到视频发布地，要平台按《互联网广告管理办法》第十六条提供。先点「导出待查发布地清单」把没有发布地的线索交给平台，平台填好省、市后在这里导入。同一个 BV 号再导入会覆盖。' }),
      h('div', { class: 'row' }, fileIn), text,
      h('div', { class: 'row' }, h('label', null, '来源 ', source), go), msg);
  }

  function regionTables(r) {
    const none = !r.total; // 还没有推广线索：三张表都只说这一句
    const table = (title, rows, emptyText, foot) => h('div', { class: 'card rt' }, h('h4', { text: title }),
      rows.length ? h('table', null, h('thead', null, h('tr', null, h('th', { text: '地区' }), h('th', { class: 'n', text: '线索' }), h('th', { class: 'n', text: '待复核' }))),
        h('tbody', null, rows.map((x) => h('tr', null, h('td', { text: x.label }), h('td', { class: 'n', text: int(x.n) }), h('td', { class: 'n', text: int(x.pending) }))))) : h('p', { class: 'muted', style: 'font-size:13px;margin:0', text: none ? '还没有推广线索。' : emptyText }),
      foot && !none ? h('p', { class: 'muted', style: 'font-size:12px;margin:8px 0 0', text: foot }) : null);
    return h('div', { class: 'rts' },
      table('发布地（平台提供）', r.pub, '还没有发布地数据。到「线索」页点「导出待查发布地清单」交给平台，拿回来导入。', `${int(r.total)} 条线索里 ${int(r.pubUnknown)} 条发布地未知`),
      table('内容里写到的城市', r.content, '还没有认出城市的线索。', `${int(r.contentNone)} 条没写到城市（参考，不是发布地）`),
      table('品牌方所在地', r.brand, '推广品牌都不在对照表里。设置里可以补。', `${int(r.brandNone)} 条对不上（参考，不是发布地）`));
  }

  async function leadsPage(openBv, query) {
    if (query?.view && VIEW_NAMES.some(([k]) => k === query.view)) { leadState.view = query.view; leadState.page = 0; }
    if (query?.grade !== undefined && ['', 'A', 'B', 'C'].includes(query.grade)) { leadState.grade = query.grade; leadState.page = 0; }
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': '看哪些' });
    const qIn = h('input', { type: 'search', placeholder: '搜标题、UP 主或 BV 号', 'aria-label': '搜索线索', value: leadState.q });
    const sel = (id, label, options, value) => { const s = h('select', { 'aria-label': label }, options.map(([v, t]) => h('option', { value: v, text: t }))); s.value = value; return s; };
    const gradeSel = sel('g', '等级', [['', '等级：全部'], ['A', 'A 级'], ['B', 'B 级'], ['C', 'C 级']], leadState.grade);
    const formSel = sel('f', '推广形式', [['', '形式：全部'], ...FORMS.map((f) => [f, f])], leadState.form);
    const attSel = sel('a', '需要注意', [['', '注意事项：全部'], ...Object.keys(ATT_SHORT).map((a) => [a, a])], leadState.attention);
    const pubSel = h('select', { 'aria-label': '发布地（平台提供）' });
    const placeSel = h('select', { 'aria-label': '参考城市（内容里写的或品牌方所在地）' });
    const sortSel = sel('s', '排序', [['grade', '按等级'], ['play', '按播放'], ['date', '按发布时间'], ['found', '按发现时间']], leadState.sort);
    const count = h('span', { class: 'count', 'aria-live': 'polite' });
    const tbody = h('tbody');
    const table = h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['等级', '视频', '播放', '商业关系', '形式', '披露', '问题', '需要注意', '发布地', '参考城市', '状态'].map((t, i) => h('th', { class: i === 2 || i === 6 ? 'n' : null, text: t })))), tbody));
    const prev = h('button', { type: 'button', text: '上一页' }), next = h('button', { type: 'button', text: '下一页' }), pageNo = h('span');
    const imp = importPanel(() => load());
    const impBtn = h('button', { class: 'btn ghost small', type: 'button', text: '导入发布地', 'aria-expanded': 'false' });
    impBtn.addEventListener('click', () => { imp.hidden = !imp.hidden; impBtn.setAttribute('aria-expanded', String(!imp.hidden)); });
    view.replaceChildren(
      head('线索', '机器判为推广的视频都在这里。「待复核」是还没人看过的；点一行看证据、写复核。复核只影响这里的结论和导出的表格，不会改动原始证据。',
        h('a', { class: 'btn ghost small', href: '/api/export/leads.csv', download: '', text: '导出表格（CSV）' }),
        h('a', { class: 'btn ghost small', href: '/api/locations/template.csv', download: '', text: '导出待查发布地清单' }), impBtn),
      imp,
      seg, h('div', { class: 'filters' }, qIn, gradeSel, formSel, attSel, pubSel, placeSel, sortSel, count), table,
      h('div', { class: 'pager' }, prev, pageNo, next),
      h('p', { class: 'muted', style: 'font-size:13px;margin:0 0 40px', text: '等级：A = 确定推广，且挂了购物链接或有其他疑似问题；B = 其余推广；C = 无推广。「问题」是疑似问题的处数（含未标明广告）。结论是线索，不是违法认定。' }));

    let seq = 0;
    async function load() {
      const my = ++seq;
      const qs = new URLSearchParams(Object.entries(leadState).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, String(v)]));
      const d = await api(`/api/leads?${qs}`);
      if (my !== seq) return;
      seg.replaceChildren(...VIEW_NAMES.map(([k, t]) => {
        const b = h('button', { type: 'button', 'aria-pressed': String(leadState.view === k) }, t, h('span', { class: 'n', text: int(d.counts[k] ?? 0) }));
        b.addEventListener('click', () => { leadState.view = k; leadState.page = 0; history.replaceState(null, '', `#/leads?view=${k}`); load(); });
        return b;
      }));
      count.textContent = `${int(d.total)} 条`;
      // 选中的地区在这一栏里已经没有了（比如切了标签）：留一个「当前筛选」项，免得看着是「全部」其实还在筛
      const keep = (select, value) => {
        select.value = value;
        if (select.value !== value) { select.appendChild(h('option', { value, text: '当前筛选（这一栏里没有）' })); select.value = value; }
      };
      pubSel.replaceChildren(...pubOptions(d.facets.pub));
      keep(pubSel, leadState.pub);
      placeSel.replaceChildren(...placeOptions(d.facets.place).filter(Boolean));
      keep(placeSel, leadState.place);
      pageNo.textContent = `第 ${d.page + 1} / ${d.pages} 页`;
      prev.disabled = d.page === 0;
      next.disabled = d.page >= d.pages - 1;
      leadState.page = d.page;
      tbody.replaceChildren(...(d.rows.length ? d.rows.map(leadRow) : [h('tr', null, h('td', { colspan: '11', class: 'muted', text: leadState.view === 'pending' ? '没有待复核的线索。' : '没有符合条件的视频。' }))]));
    }
    function leadRow(r) {
      const tr = h('tr', { class: 'click', tabindex: '0' },
        h('td', null, gradeBadge(r.grade)),
        h('td', null, h('div', { class: 't-title', text: r.title }), h('div', { class: 't-sub' }, `${r.author} · `, h('span', { class: 'mono', text: r.bvid }), ` · 发布 ${ymd(r.pubdate)}`)),
        h('td', { class: 'n', text: compact(r.play) }),
        h('td', null, commercialBadge(r.commercial)),
        h('td', { text: r.form === '无' ? '—' : r.form }),
        h('td', null, discBadge(r.disclosure, r.promo) || '—'),
        h('td', { class: 'n', text: String(r.flags.length) }),
        h('td', null, attBadges(r.attention)),
        h('td', null, pubCell(r.pub)),
        h('td', null, refCell(r.region)),
        h('td', null, leadBadge(r.status)));
      const open = () => openLead(r.bvid, load);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      return tr;
    }
    let t;
    qIn.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { leadState.q = qIn.value.trim(); leadState.page = 0; load(); }, 250); });
    for (const [el, key] of [[gradeSel, 'grade'], [formSel, 'form'], [attSel, 'attention'], [pubSel, 'pub'], [placeSel, 'place'], [sortSel, 'sort']]) el.addEventListener('change', () => { leadState[key] = el.value; leadState.page = 0; load(); });
    prev.addEventListener('click', () => { leadState.page--; load(); });
    next.addEventListener('click', () => { leadState.page++; load(); });
    onEvent((e) => { if (e.type === 'run' && e.status !== 'running') load(); });
    await load();
    if (openBv && /^BV[0-9A-Za-z]{10}$/.test(openBv)) openLead(openBv, load);
  }

  // ── 证据抽屉 ──
  const drawer = $('drawer'), back = $('drawer-back'), inner = $('drawer-in');
  let lastFocus = null, afterClose = null;
  function showDrawer() {
    if (drawer.hidden) lastFocus = document.activeElement;
    drawer.hidden = false;
    void drawer.offsetWidth; // 先回流再加 on，过渡照样生效（窗口在后台时 requestAnimationFrame 不触发）
    drawer.classList.add('on'); back.classList.add('on');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    if (drawer.hidden) return;
    drawer.classList.remove('on'); back.classList.remove('on');
    document.body.style.overflow = '';
    for (const a of inner.querySelectorAll('audio')) a.pause();
    setTimeout(() => { if (!drawer.classList.contains('on')) drawer.hidden = true; }, 220);
    if (/^#\/leads\/BV/.test(location.hash)) history.replaceState(null, '', `#/leads?view=${leadState.view}`);
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    const f = afterClose; afterClose = null; if (f) f();
  }
  back.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden && !document.querySelector('.lightbox.on')) closeDrawer(); });
  // 从抽屉直接点顶栏去别的页：关掉抽屉（不再回头刷新列表）
  window.addEventListener('hashchange', () => { if (!/^#\/leads\/BV/.test(location.hash) && !drawer.hidden) { afterClose = null; closeDrawer(); } });
  const dtop = (title) => h('div', { class: 'drawer-top' }, h('h2', { id: 'd-title', text: title }), h('button', { class: 'close-btn', type: 'button', onclick: closeDrawer, text: '关闭' }));
  const dsec = (title, ...kids) => h('section', { class: 'd-sec' }, h('h3', { text: title }), ...kids);

  let changed = false;
  async function openLead(bvid, reloadList) {
    changed = false;
    afterClose = () => { if (changed && reloadList) reloadList(); };
    history.replaceState(null, '', `#/leads/${bvid}`);
    inner.replaceChildren(dtop('正在加载…'), h('p', { class: 'muted', text: '正在加载证据…' }));
    showDrawer();
    inner.querySelector('.close-btn').focus();
    try { renderLead(await api(`/api/leads/${bvid}`)); } catch (e) { inner.appendChild(h('p', { class: 'callout warn', text: e.message })); }
  }

  const AD_RX = /广告|商业推广|推广|赞助|商业合作|合作推广|品牌合作|恰饭|商单|金主|本期视频由|特别鸣谢|sponsor/i;
  const DIS_RX = /(不能|不可|不得)(代替|替代)(药|藥)|不代替药/;

  function renderLead(d) {
    const v = d.video, lead = d.lead, lab = d.label?.output, promo = !!lead?.promo;
    const segs = (lab?.segments ?? []).map((g) => { const a = toSec(g.start), b = toSec(g.end); return { ...g, a, b: b ?? (a == null ? null : a + 5) }; }).filter((g) => g.a != null);
    const inPromo = (t) => segs.some((g) => t >= g.a - 1 && t <= g.b + 1);
    const frames = d.frames?.list ?? [];
    const hitOf = (f) => ((f.texts ?? []).some((x) => AD_RX.test(x.text)) ? 'ad' : (f.texts ?? []).some((x) => DIS_RX.test(x.text)) ? 'dis' : null);
    const parts = [dtop(v.title)];
    const post = []; // 插进页面之后才能画的（时间轴要量宽度）

    // 结论
    if (lead) {
      parts.push(h('div', { class: 'badges', style: 'margin-top:14px' }, gradeBadge(lead.grade), commercialBadge(lead.commercial),
        lead.form && lead.form !== '无' ? h('span', { class: 'badge b-soft', text: lead.form }) : null, discBadge(lead.disclosure, promo), leadBadge(lead.status)));
    }
    parts.push(reviewCard(d));
    if (lead?.attention?.length) {
      parts.push(h('div', { class: 'callout' }, h('b', { text: '需要注意' }), h('ul', { style: 'margin:6px 0 0;padding-left:1.2em' }, lead.attention.map((a) => h('li', { text: meta.attention[a] ? `${a}：${meta.attention[a]}` : a })))));
    }
    parts.push(dsec('基本信息', kv([
      ['UP 主', `${v.author}（mid ${v.mid}）`], ['发布', `${ymd(v.pubdate)} · 时长 ${mmss(v.duration ?? 0)} · ${d.page?.tname || v.typename || '—'}`], ['播放', int(v.play)],
      ['链接', ext(biliUrl(v.bvid), biliUrl(v.bvid))],
      d.screening ? ['初筛', `推广分 ${d.screening.score ?? '—'}${d.screening.reasons?.length ? `：${d.screening.reasons.slice(0, 4).join('；')}` : ''}`] : null,
      ['判定', d.label ? `${d.label.model} · ${dt(d.label.labeledAt)}` : '还没判定'],
      ['披露依据', lead ? `${d.label?.disclosure === '声明含营销信息' ? `创作者声明「${d.page?.argue || '含营销信息'}」，文字与口播没写「广告」` : `文字与口播：${d.label?.disclosure ?? '—'}`}${d.frames?.ok ? `；画面：${d.hits?.ad?.length ? `读到 ${d.hits.ad.length} 处广告类字样（待看图确认）` : '抽查的画面没读到广告字样'}` : '；画面：没取帧'}` : '—'],
    ])));

    parts.push(regionSection(d));

    // 时间轴
    if (v.duration > 0 && (segs.length || frames.length)) {
      const tlEl = h('div');
      parts.push(dsec('证据时间轴', tlEl, h('div', { class: 'tl-legend' }, h('span', null, h('i', { class: 'k-seg' }), '推广段'), h('span', null, h('i', { class: 'k-tick' }), `取帧（${frames.length} 帧）`), h('span', null, h('i', { class: 'k-mark' }), '画面读到广告 / 不能代替药物字样'))));
      post.push(() => C.timeline(tlEl, {
        dur: v.duration, segments: segs.map((g) => ({ a: g.a, b: g.b, tip: `${g.brand ?? ''} ${g.product ?? ''} · ${g.product_type ?? ''}` })), ticks: frames.map((f) => f.t),
        marks: frames.filter(hitOf).map((f) => ({ t: f.t, kind: hitOf(f) === 'ad' ? 'ad' : '', label: (f.texts ?? []).filter((x) => AD_RX.test(x.text) || DIS_RX.test(x.text)).map((x) => x.text).join(' / ') })),
      }));
    }

    // 问题与法条
    if (lead) {
      parts.push(dsec('疑似问题与法条', ...(lead.flags.length ? lead.flags.map((f) => h('div', { class: 'flag' }, h('b', { text: f.type.replace('_挂链', '（挂了购物链接）') }), f.time ? h('span', { class: 'mono muted', text: `  ${f.time}` }) : null,
        f.quote ? h('div', null, h('q', { text: f.quote })) : null, f.law ? h('div', { class: 'law', text: f.law }) : null)) : [h('p', { class: 'muted', text: '没有疑似问题。' })])));
    }
    if (d.label?.quotes?.length) {
      parts.push(dsec('原话核对（模型引用的话，回转写、简介、置顶里找）', h('div', { class: 'qchk' }, d.label.quotes.map((q) => [
        h('span', { class: 'muted', text: q.kind }), stBadge(q.status === 'ok' ? 'done' : q.status === '部分' ? 'stopped' : 'failed', q.status === 'ok' ? '找到了' : q.status === '部分' ? '部分' : '找不到'), h('q', { text: q.quote })]))));
    }
    // 两个模型
    const m2 = d.second;
    parts.push(dsec('两个模型的结论', kv([
      ['第一个模型', lab ? `${lab.commercial} / ${lab.form}${lab.note ? ` —— ${lab.note}` : ''}（${d.label.model}）` : d.label?.error ? `失败：${d.label.error}` : '还没判定'],
      ['第二个模型', m2?.output ? `${m2.output.commercial} / ${m2.output.form}${m2.output.note ? ` —— ${m2.output.note}` : ''}（${m2.model}）` : m2?.error ? `失败：${m2.error}` : '没做（设置里关了，或还没轮到）'],
    ])));
    if (segs.length) {
      parts.push(dsec('推广段', ...segs.map((g) => h('div', { class: 'flag' }, h('span', { class: 'mono', text: `${g.start}–${g.end}` }), '  ', h('b', { text: `${g.brand ?? ''} ${g.product ?? ''}`.trim() || '（没标品牌）' }), h('span', { class: 'muted', text: `  ${g.product_type ?? ''}` }), g.quote ? h('div', null, h('q', { text: g.quote })) : null))));
    }
    // 画面
    if (frames.length) {
      parts.push(dsec(`画面（${frames.length} 帧，视觉模型读字）`, h('div', { class: 'frames-grid' }, frames.map((f) => {
        const hit = hitOf(f), texts = (f.texts ?? []).map((x) => x.text);
        const cap = texts.filter((t) => AD_RX.test(t) || DIS_RX.test(t)).concat(texts).slice(0, 2).join(' / ');
        return h('figure', { class: `frame${hit === 'ad' ? ' hit-ad' : hit === 'dis' ? ' hit-dis' : ''}${inPromo(f.t) ? ' promo-t' : ''}` },
          h('button', { type: 'button', 'aria-label': `放大 ${mmss(f.t)} 的画面`, onclick: () => lightbox(ws(f.file), `${mmss(f.t)} · 画面文字：${texts.join(' / ') || '（没有）'}${f.texts === null ? '（没读出来）' : ''}`) },
            h('img', { src: ws(f.file), alt: `${mmss(f.t)} 的画面`, loading: 'lazy' })),
          h('figcaption', null, h('span', { class: 'mono', text: mmss(f.t) }), inPromo(f.t) ? ' · 推广段' : '', h('br'), cap ? cap.slice(0, 60) : h('span', { class: 'muted', text: f.texts === null ? '没读出来' : '无文字' })));
      }))));
    } else if (d.frames?.error) {
      parts.push(dsec('画面', h('p', { class: 'muted', text: `没取到画面：${d.frames.error}` })));
    }
    // 转写 + 音频
    if (d.transcript) {
      const hasAudio = d.media?.audioExists;
      const audio = hasAudio ? h('audio', { controls: true, preload: 'none', src: ws(`audio/${v.bvid}.m4a`) }) : null;
      const lines = d.transcript.map(([s, e, text]) => {
        const btn = h('button', { type: 'button', text: mmss(s), 'aria-label': `从 ${mmss(s)} 播放`, disabled: !hasAudio });
        if (audio) btn.addEventListener('click', () => { audio.currentTime = s; audio.play().catch(() => {}); });
        return h('div', { class: `tr-line${inPromo(s) ? ' promo' : ''}`, dataset: { s, e } }, btn, h('span', { text }));
      });
      const box = h('div', { class: 'transcript' }, lines.length ? lines : h('p', { class: 'muted', style: 'padding:8px 14px', text: '没有识别到人声。' }));
      if (audio) {
        let cur = null;
        audio.addEventListener('timeupdate', () => {
          const t = audio.currentTime;
          const line = lines.find((l) => t >= Number(l.dataset.s) && t < Number(l.dataset.e) + 0.3);
          if (line && line !== cur) { cur?.classList.remove('now'); line.classList.add('now'); cur = line; box.scrollTop = line.offsetTop - box.offsetTop - box.clientHeight / 3; }
        });
      }
      parts.push(dsec('口播转写（本机 SenseVoice，有识别错字；黄底是推广段）', audio ?? h('p', { class: 'muted', text: d.media?.audioDeleted ? '音频已按设置删除（判为无推广），转写和哈希还在。' : '没有音频文件。' }), box));
    }
    // 页面信息
    if (d.page || d.pinned) {
      parts.push(dsec('页面信息', kv([
        ['简介', h('div', { style: 'white-space:pre-wrap', text: d.page?.desc || '（空）' })],
        ['置顶评论', d.pinned ? h('div', null, h('p', { style: 'white-space:pre-wrap;margin:0 0 6px', text: d.pinned.text }), d.pinned.links?.length ? h('ul', { class: 'hash' }, d.pinned.links.map((u) => h('li', { text: u }))) : null) : '（没有置顶评论）'],
        ['创作者声明', d.page?.argue || '（无）'],
        d.page?.staff?.length ? ['联合投稿', d.page.staff.map((x) => `${x.name}（${x.title}）`).join('、')] : null,
        ['标题区文字', h('span', { class: 'ink2', text: d.page?.infoText || '—' })],
      ])));
    }
    // 存证
    if (d.media) {
      const shot = d.media.files?.find((f) => f.path.endsWith('page.png'));
      parts.push(dsec('存证', kv([
        ['页面采集', `${dt(d.media.fetchedAt)} · ${d.media.browser ?? '—'} · ${d.media.script ?? '—'}`],
        ...(d.media.files ?? []).map((f) => [f.path.split('/').pop(), h('div', { class: 'hash' }, `${f.path} · ${int(f.bytes)} 字节`, h('br'), `SHA-256 ${f.sha256}`)]),
        d.frames?.ok ? ['画面采集', `${dt(d.frames.fetchedAt)} · ${d.frames.stream?.width}×${d.frames.stream?.height} ${d.frames.stream?.codecs ?? ''} · 请求 ${d.frames.requests} 次 · ${int(d.frames.bytes)} 字节 · ${d.frames.stream?.usedHost ?? d.frames.stream?.host ?? ''}`] : null,
        frames.length ? ['截帧哈希', h('span', { class: 'hash', text: `每帧的 SHA-256 在工作区 frames/manifest.jsonl（本条 ${frames.length} 帧）` })] : null,
      ]), shot ? h('button', { type: 'button', style: 'all:unset;cursor:zoom-in;display:block;margin-top:12px', 'aria-label': '放大页面截图', onclick: () => lightbox(ws(shot.path), `${v.bvid} 页面截图 · ${dt(d.media.fetchedAt)}`) },
        h('img', { class: 'shot', src: ws(shot.path), alt: `${v.bvid} 页面截图`, loading: 'lazy' })) : null));
    }
    const y = drawer.scrollTop;
    inner.replaceChildren(...parts);
    for (const f of post) f();
    drawer.scrollTop = y;
  }

  // 地区：发布地（平台提供，可在这里录入这一条）、内容里写到的城市、品牌方所在地——三块分开
  function regionSection(d) {
    const r = d.region ?? { pub: null, content: [], brand: [] };
    const bv = d.video.bvid, promo = !!d.lead?.promo;
    const prov = h('input', { type: 'text', maxlength: '12', placeholder: '省', 'aria-label': '发布地省份', value: r.pub?.province ?? '' });
    const city = h('input', { type: 'text', maxlength: '12', placeholder: '市', 'aria-label': '发布地城市', value: r.pub?.city ?? '' });
    const note = h('input', { type: 'text', maxlength: '200', placeholder: '依据（如平台回函编号）', 'aria-label': '发布地依据', value: r.pub?.note ?? '' });
    const err = h('span', { class: 'err', role: 'alert' });
    const save = h('button', { class: 'btn small', type: 'button', text: '保存发布地' });
    save.addEventListener('click', async () => {
      err.textContent = '';
      save.disabled = true;
      try {
        const nd = await api(`/api/leads/${bv}/location`, { method: 'PUT', body: { province: prov.value, city: city.value, note: note.value, by: savedReviewer() } });
        changed = true; toast('发布地已保存'); renderLead(nd);
      } catch (e) { err.textContent = e.message; save.disabled = false; }
    });
    const form = h('div', { class: 'loc-form', hidden: !!r.pub }, prov, city, note, save, err);
    let pubBlock;
    if (r.pub) {
      const edit = h('button', { class: 'tbl-toggle', type: 'button', text: '修改' });
      edit.addEventListener('click', () => { form.hidden = !form.hidden; });
      const clear = h('button', { class: 'tbl-toggle', type: 'button', text: '清除' });
      clear.addEventListener('click', async () => {
        if (!confirm('清除这条视频的发布地？')) return;
        try { const nd = await api(`/api/leads/${bv}/location`, { method: 'DELETE' }); changed = true; toast('已清除'); renderLead(nd); } catch (e) { err.textContent = e.message; }
      });
      pubBlock = h('p', { style: 'margin:0' }, h('b', { text: placeLabel(r.pub) }),
        h('span', { class: 'muted', text: `　来源：${r.pub.source || '—'}${r.pub.note ? `（${r.pub.note}）` : ''} · ${dt(r.pub.at)}${r.pub.by ? ` · ${r.pub.by}` : ''}　` }), edit, '　', clear);
    } else {
      pubBlock = h('p', { class: 'muted', style: 'margin:0', text: '未知。B站 游客看不到视频发布地，要平台依法提供；拿到后在「线索」页批量导入，或者在下面录入这一条。' });
    }
    const quoteBadge = (s) => stBadge(s === 'ok' ? 'done' : s === '部分' ? 'stopped' : 'failed', s === 'ok' ? '原话找到了' : s === '部分' ? '原话部分对上' : '原话找不到');
    const content = r.content.length
      ? h('ul', { class: 'plist' }, r.content.map((x) => h('li', null, h('b', { text: placeLabel(x) }), h('span', { class: 'muted', text: ` · ${x.role} · 出处：${x.source || '—'}　` }), quoteBadge(x.status), x.quote ? h('div', null, h('q', { text: x.quote })) : null)))
      : h('p', { class: 'muted', style: 'margin:0', text: r.placesError ? `没识别出来（下一轮再试）：${r.placesError}` : r.placesAt ? '材料里没写到商家或服务所在的城市。' : promo ? '还没识别（设置里关了，或者还没轮到）。' : '不是推广，不识别。' });
    const brand = r.brand.length
      ? h('ul', { class: 'plist' }, r.brand.map((x) => h('li', null, h('b', { text: placeLabel(x) }), h('span', { class: 'muted', text: ` · ${x.brand}${x.company ? ` → ${x.company}` : ''}` }), x.source ? h('div', { class: 'hash', text: `来源：${x.source}` }) : null)))
      : h('p', { class: 'muted', style: 'margin:0', text: '推广的品牌不在对照表里（设置里可以补）。' });
    return dsec('地区', h('div', { class: 'region' },
      h('h4', { text: '发布地（平台提供）' }), pubBlock, form,
      h('h4', { text: '内容里写到的城市（参考，不是发布地）' }), content,
      r.content.length ? h('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0', text: '只有「门店/经营地、服务地区、同城标签、厂址」并且原话找得到的，才参与筛选。' }) : null,
      h('h4', { text: '品牌方所在地（参考，不是发布地）' }), brand));
  }

  function reviewCard(d) {
    const lead = d.lead, rv = d.review;
    if (!d.label?.output || !lead) return h('div', { class: 'review' }, h('p', { class: 'muted', style: 'margin:0', text: '这条还没判定完，暂时不能复核。' }));
    const promo = lead.promo;
    const choices = promo ? [['confirm', '确认没问题'], ['modify', '修改'], ['reject', '不是推广']] : [['reject', '确实不是推广'], ['modify', '其实是推广']];
    let verdict = null;
    const flagTypes = [...new Set((d.label.flags ?? []).map((f) => f.type))];
    const err = h('span', { class: 'err', role: 'alert' });
    const comSel = h('select', { 'aria-label': '商业关系' }, h('option', { value: '', text: promo ? `不改（${d.label.output.commercial}）` : '选一个' }), h('option', { value: '确定', text: '确定' }), h('option', { value: '疑似', text: '疑似' }));
    const formSel = h('select', { 'aria-label': '推广形式' }, h('option', { value: '', text: `不改（${d.label.output.form}）` }), FORMS.map((f) => h('option', { value: f, text: f })));
    const flagBoxes = flagTypes.map((t) => { const cb = h('input', { type: 'checkbox', value: t }); return [cb, h('label', null, cb, `去掉「${t.replace('_挂链', '（挂链）')}」`)]; });
    const frameCb = h('input', { type: 'checkbox' });
    const more = h('div', { class: 'more', hidden: true },
      h('div', { class: 'row' }, h('span', { text: '商业关系' }), comSel),
      h('div', { class: 'row' }, h('span', { text: '推广形式' }), formSel),
      flagBoxes.length ? h('div', { class: 'row' }, h('span', { text: '问题' }), flagBoxes.map(([, l]) => l)) : null,
      promo ? h('div', { class: 'row' }, h('span', { text: '画面' }), h('label', null, frameCb, '画面上已写明「广告」（看过截帧确认）')) : null);
    const who = h('input', { type: 'text', value: rv?.reviewer || savedReviewer(), maxlength: '30', placeholder: '复核人', 'aria-label': '复核人' });
    const note = h('textarea', { placeholder: '备注（可不填）：为什么这样判、看了哪里', maxlength: '1000', 'aria-label': '复核备注' });
    note.value = rv?.note ?? '';
    const btns = choices.map(([k, t]) => {
      const b = h('button', { type: 'button', 'aria-pressed': 'false', text: t });
      b.addEventListener('click', () => { verdict = k; for (const x of btns) x.setAttribute('aria-pressed', String(x === b)); more.hidden = k !== 'modify'; err.textContent = ''; });
      return b;
    });
    const save = h('button', { class: 'btn small', type: 'button', text: '保存复核' });
    save.addEventListener('click', async () => {
      if (!verdict) { err.textContent = '先选一个结论'; return; }
      if (!who.value.trim()) { err.textContent = '请填复核人'; who.focus(); return; }
      const body = { verdict, reviewer: who.value.trim(), note: note.value };
      if (verdict === 'modify') Object.assign(body, { commercial: comSel.value || null, form: formSel.value || null, removeFlags: flagBoxes.filter(([cb]) => cb.checked).map(([cb]) => cb.value), frameDisclosed: frameCb.checked });
      save.disabled = true;
      try {
        const nd = await api(`/api/leads/${d.video.bvid}/review`, { method: 'POST', body });
        saveReviewer(body.reviewer);
        changed = true;
        toast('复核已保存');
        renderLead(nd);
        refreshNav();
      } catch (e) { err.textContent = e.message; save.disabled = false; }
    });
    const undo = rv ? h('button', { class: 'btn ghost small', type: 'button', text: '撤销复核' }) : null;
    undo?.addEventListener('click', async () => {
      if (!confirm('撤销这条复核？线索会回到机器的结论。')) return;
      try { const nd = await api(`/api/leads/${d.video.bvid}/review`, { method: 'DELETE' }); changed = true; toast('已撤销'); renderLead(nd); refreshNav(); } catch (e) { err.textContent = e.message; }
    });
    const VERDICT = { confirm: '确认没问题', modify: '修改了结论', reject: '判为不是推广' };
    return h('div', { class: 'review' },
      h('h3', null, rv ? '复核' : '复核这条线索', leadBadge(lead.status)),
      rv ? h('p', { class: 'done' }, `${rv.reviewer} 于 ${dt(rv.reviewedAt)} ${VERDICT[rv.verdict] ?? rv.verdict}${rv.note ? `：${rv.note}` : ''}。可以改判，保存后覆盖。`) : null,
      h('div', { class: 'choices' }, btns), more,
      h('div', { class: 'row', style: 'margin-top:12px' }, h('span', { text: '复核人' }), who),
      h('div', { style: 'margin-top:8px' }, note),
      h('div', { class: 'foot' }, save, undo, err));
  }

  // ── 运行记录 ──
  async function runsPage() {
    const runs = await api('/api/runs');
    const rows = runs.map((r) => {
      const s = r.stats ?? {}, tk = r.tokens ?? {};
      const tr = h('tr', { class: 'click', tabindex: '0' },
        h('td', { text: dt(r.startedAt) }), h('td', { text: r.trigger }), h('td', null, stBadge(r.status)),
        h('td', { class: 'n', text: r.finishedAt ? dur((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) : '—' }),
        h('td', { class: 'n', text: int(s.newVideos ?? 0) }), h('td', { class: 'n', text: int(s.inScopeNew ?? 0) }),
        h('td', { class: 'n', text: int(s.collected ?? 0) }), h('td', { class: 'n', text: int(s.labeled ?? 0) }),
        h('td', { class: 'n', text: int(s.leadsNew ?? 0) }),
        h('td', { class: 'n', text: compact((tk.label ?? 0) + (tk.second ?? 0) + (tk.vision ?? 0) + (tk.places ?? 0)) }),
        h('td', { class: 'n', text: int(s.requests ?? 0) }));
      const open = () => { location.hash = `#/runs/${r.runId}`; };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      return tr;
    });
    view.replaceChildren(
      head('运行记录', '每一轮做了什么、花了多少。点一行看这一轮每一步的情况和完整日志。'),
      runs.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['开始', '触发', '状态', '用时', '新视频', '范围内', '采集', '判定', '新线索', '大模型 token', 'B站 请求'].map((t, i) => h('th', { class: i >= 3 ? 'n' : null, text: t })))),
        h('tbody', null, rows))) : h('p', { class: 'empty', text: '还没跑过。' }),
      h('div', { style: 'height:40px' }));
    onEvent((e) => { if (e.type === 'run') route(); });
  }

  async function runDetail(id) {
    const r = await api(`/api/runs/${encodeURIComponent(id)}`);
    const titles = Object.fromEntries(r.steps.map((s) => [s.id, s.title]));
    const steps = stepsList(r);
    const s = r.stats ?? {}, tk = r.tokens ?? {};
    const logBox = h('div', { class: 'logbox', style: 'max-height:none', role: 'log', 'aria-label': '这一轮的日志' }, r.events.length ? r.events.map((e) => logLine(e, titles)) : h('span', { class: 'muted', text: '没有日志' }));
    view.replaceChildren(
      head(`${dt(r.startedAt)} 这一轮`, `${r.triggerName}运行 · 找 ${dt(r.since)} 以后发布的视频${r.finishedAt ? ` · 用时 ${dur((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)}` : ''}`, h('a', { class: 'btn ghost small', href: '#/runs', text: '返回运行记录' })),
      h('div', { class: 'rp-state', style: 'margin-bottom:12px' }, stBadge(r.status)),
      r.error ? h('p', { class: 'callout warn', text: r.error }) : null,
      steps,
      secH('数字'),
      h('dl', { class: 'kvs' }, [
        ['新视频', s.newVideos], ['范围内', s.inScopeNew], ['取了评论区', s.commentsFetched], ['留到下一轮', s.commentsDeferred], ['打开视频页', s.pagesOpened], ['拿到音频', s.collected],
        ['还在排队', s.collectLeft], ['转写', s.transcribed != null ? `${s.transcribed} 条，${s.audioMinutes ?? 0} 分钟音频` : null], ['判定', s.labeled], ['模型判为推广', s.labeledPromo],
        ['交叉检验', s.secondChecked], ['两模型分歧', s.disagreements], ['取帧', s.framesVideos != null ? `${s.framesVideos} 条视频、${s.frames ?? 0} 帧` : null], ['读画面', s.visionFrames],
        ['新线索', s.leadsNew != null ? `${s.leadsNew} 条（A ${s.leadsNewA ?? 0}、B ${s.leadsNewB ?? 0}）` : null], ['删掉音频', s.audioDeleted], ['B站 请求', s.requests],
        ['识别地区', s.placesChecked != null ? `${s.placesChecked} 条，认出城市 ${s.placesWithCity ?? 0} 条` : null],
        ['token', `判定 ${int(tk.label ?? 0)} · 交叉 ${int(tk.second ?? 0)} · 读画面 ${int(tk.vision ?? 0)} · 认地区 ${int(tk.places ?? 0)}`],
      ].filter(([, v]) => v != null).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: typeof v === 'number' ? int(v) : String(v) })])),
      secH('日志'), logBox, h('div', { style: 'height:40px' }));
    if (r.status === 'running') {
      onEvent((e) => {
        if (e.runId !== r.runId && e.type !== 'reconnect') return;
        if (e.type === 'step') steps.update(e);
        if (e.type === 'log') { logBox.querySelector('.muted')?.remove(); logBox.appendChild(logLine(e, titles)); }
        if (e.type === 'run' || e.type === 'reconnect') route();
      });
    }
  }

  // ── 设置 ──
  async function settingsPage() {
    const d = await api('/api/settings');
    let s = d.settings;
    // 必填的只有搜索关键词（打开定时时还有时间）；数字留空按默认值，品类词留空用搜索关键词，其余留空就是不用。每项的灰字写明留空怎么算
    const num = (key, label, hint, min, max) => { const i = h('input', { type: 'number', min: String(min), max: String(max), step: '1', value: String(s[key]), name: key, placeholder: `默认 ${d.defaults[key]}` }); return [key, i, h('label', { class: 'f' }, h('span', { text: label }), i, h('small', { text: `${hint ? `${hint}。` : ''}留空按默认值 ${d.defaults[key]}` }))]; };
    const chk = (key, label, hint, get = () => s[key]) => { const i = h('input', { type: 'checkbox', name: key }); i.checked = !!get(); return [key, i, h('label', { class: 'check' }, i, h('span', null, label, hint ? h('small', { text: hint }) : null))]; };
    const area = (key, label, hint, must = false) => { const i = h('textarea', { name: key, rows: '4' }); i.value = s[key].join('\n'); return [key, i, h('label', { class: 'f wide' }, h('span', { text: `${label}（${must ? '必填，' : ''}一行一个，${s[key].length} 个）` }), i, hint ? h('small', { text: hint }) : null)]; };
    const text = (key, label, hint, placeholder) => { const i = h('input', { type: 'text', name: key, value: s[key] ?? '', maxlength: '30', placeholder }); return [key, i, h('label', { class: 'f' }, h('span', { text: label }), i, hint ? h('small', { text: hint }) : null)]; };

    const schOn = chk('schedule.enabled', '到点自动运行', '网页服务开着时才会到点运行（电脑开机、不睡眠）。错过的时段，服务再打开时补跑一次。', () => s.schedule.enabled);
    const freq = h('select', { name: 'frequency' }, h('option', { value: 'daily', text: '每天' }), h('option', { value: 'weekly', text: '每周' }));
    freq.value = s.schedule.frequency;
    const time = h('input', { type: 'time', value: s.schedule.time, name: 'time' });
    const wday = h('select', { name: 'weekday' }, WEEK.map((w, i) => h('option', { value: String(i), text: w })));
    wday.value = String(s.schedule.weekday);
    const wdayLabel = h('label', { class: 'f' }, h('span', { text: '星期' }), wday);
    const syncW = () => { wdayLabel.hidden = freq.value !== 'weekly'; };
    freq.addEventListener('change', syncW);
    syncW();

    const f = {
      firstRunDays: num('firstRunDays', '第一轮回溯几天', '第一次运行时，找最近几天发布的视频', 1, 14),
      maxLookbackDays: num('maxLookbackDays', '最长回溯几天', '隔了很久没跑时最多补这么多天（太长会撞上搜索 1000 条上限）', 1, 14),
      minAgeHours: num('minAgeHours', '发布满几小时再处理', 'UP 主常在发布后才补置顶链接，太新的视频留到下一轮', 0, 72),
      maxDeepPerRun: num('maxDeepPerRun', '每轮最多深度分析几条', '采集 + 转写 + 判定；每条约 25 秒，剩下的下一轮接着做', 1, 2000),
      maxFramesPerVideo: num('maxFramesPerVideo', '每条视频最多取几帧', '读画面是大模型用量的大头，研究里平均每条 28 帧', 4, 200),
      secondModel: chk('secondModel', `第二个模型交叉检验（${d.models.second}）`, '另一家模型用同样的材料独立再判一遍，判得不一样的会标「两模型分歧」。关掉能省约一半判定用量。'),
      vision: chk('vision', `画面检查：取帧 + 读字（${d.models.vision}）`, '找画面上的「广告」「不能代替药物」等字样。关掉后「未标明广告」只看文字和口播。'),
      category: text('category', '品类名称', `留空按默认值「${d.defaults.category}」`, d.defaults.category),
      keywords: area('keywords', '搜索关键词', '按发布时间翻 B站 公开搜索结果', true),
      relevanceTerms: area('relevanceTerms', '品类词', '标题、标签、简介里出现其中一个才算范围内；留空就用搜索关键词判断'),
      brands: area('brands', '品牌', '初筛打分用：提到品牌会加分；留空就不按品牌加分'),
      minDurationS: num('minDurationS', '最短时长（秒）', '更短的视频不看', 0, 3600),
      maxPagesPerKeyword: num('maxPagesPerKeyword', '每个关键词最多翻几页', '每页 20 条，上限 50 页', 1, 50),
      excludePets: chk('excludePets', '宠物产品不算', '按分区、标题、标签认宠物（和人工判断 116/116 一致）'),
      deleteNonPromoAudio: chk('deleteNonPromoAudio', '判为无推广的视频删掉音频', '两个模型都判无推广、也没人复核时才删；转写、截图和哈希都保留。'),
      reviewer: text('reviewer', '默认复核人', '复核时自动填上（每个浏览器也会记住上次填的名字）；留空就复核时再填'),
      placeDetect: chk('placeDetect', `识别内容里写到的城市（${d.models.location ?? d.models.vision}）`, '每条推广视频多一次小模型调用：从标题、标签、简介、置顶、口播、画面里找商家门店、服务地区、「XX同城」。这是参考，不是发布地。'),
    };
    const bpText = (rows) => rows.map((r) => [r.aliases.join('/'), r.company, r.province, r.city, r.source].join(' ｜ ')).join('\n');
    const bpArea = h('textarea', { name: 'brandPlaces', rows: '6', spellcheck: 'false', placeholder: '某品牌/英文名 ｜ 某某有限公司 ｜ 广东 ｜ 珠海 ｜ 出处网址' });
    bpArea.value = bpText(s.brandPlaces ?? []);
    const bpCount = h('span', { text: `品牌方所在地对照表（${(s.brandPlaces ?? []).length} 条）` });
    const bpLabel = h('label', { class: 'f wide' }, bpCount, bpArea,
      h('small', { text: '一行一条：品牌别名（多个用 / 分隔）｜公司名称｜省｜市｜来源（企业信用信息公示系统截图、官网网址等）。推广品牌里包含某个别名就对上。只填核实过的；这是参考，不是发布地。留空就不对照。' }));
    const err = h('span', { class: 'err', role: 'alert' });
    const save = h('button', { class: 'btn', type: 'submit', text: '保存设置' });
    const reset = h('button', { class: 'btn ghost', type: 'button', text: '填回默认值' });
    const form = h('form', { class: 'form', novalidate: true },
      h('fieldset', null, h('legend', { text: '定时运行' }), schOn[2], h('div', { class: 'fields', style: 'margin-top:12px' }, h('label', { class: 'f' }, h('span', { text: '频率' }), freq), h('label', { class: 'f' }, h('span', { text: '时间' }), time, h('small', { text: '打开定时时必填' })), wdayLabel)),
      h('fieldset', null, h('legend', { text: '每轮做多少' }), h('div', { class: 'fields' }, f.firstRunDays[2], f.maxLookbackDays[2], f.minAgeHours[2], f.maxDeepPerRun[2])),
      h('fieldset', null, h('legend', { text: '模型与画面' }), h('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px', text: `判定用 ${d.models.label}（关思考、温度 0）。模型名在 config/models.json，密钥在环境变量 ARK_API_KEY。` }),
        h('div', { style: 'display:grid;gap:12px' }, f.secondModel[2], f.vision[2]), h('div', { class: 'fields', style: 'margin-top:12px' }, f.maxFramesPerVideo[2])),
      h('fieldset', null, h('legend', { text: '监测口径' }),
        h('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px', text: '这里改的是「找哪些视频」。换品类还要改判定规则和法条（src/labeling.mjs 的产品类型、src/legal.mjs 的问题类型与法条），见 README「换品类、换平台」。改口径只影响以后发现的视频。' }),
        h('div', { class: 'fields' }, f.category[2], f.minDurationS[2], f.maxPagesPerKeyword[2], f.keywords[2], f.relevanceTerms[2], f.brands[2]), h('div', { style: 'margin-top:12px' }, f.excludePets[2])),
      h('fieldset', null, h('legend', { text: '地区' }),
        h('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px', text: '视频发布地 B站 游客看不到，要平台依法提供，在「线索」页导入。这里的两项是参考：内容里写到的城市、品牌方所在地。' }),
        f.placeDetect[2], h('div', { class: 'fields', style: 'margin-top:12px' }, bpLabel)),
      h('fieldset', null, h('legend', { text: '存储与复核' }), f.deleteNonPromoAudio[2], h('div', { class: 'fields', style: 'margin-top:12px' }, f.reviewer[2]),
        h('dl', { class: 'kvs', style: 'margin-top:14px' }, h('dt', { text: '工作区' }), h('dd', { text: d.workspace }), h('dt', { text: '转写' }), h('dd', { text: `${d.app.python}，${d.app.asrShards} 路 × ${d.app.asrThreads} 线程` }), h('dt', { text: 'ffmpeg' }), h('dd', { text: d.app.ffmpeg }), h('dt', { text: '浏览器' }), h('dd', { text: d.app.browser === 'msedge' ? 'Microsoft Edge（无头）' : `${d.app.browser}（无头）` }), h('dt', { text: '改这些' }), h('dd', { text: 'config/app.json（改完重启网页服务）' }))),
      h('div', { class: 'form-bar' }, save, reset, err));

    const fill = (x) => {
      s = x;
      for (const [, [key, input]] of Object.entries(f)) {
        if (input.type === 'checkbox') input.checked = !!x[key];
        else if (input.tagName === 'TEXTAREA') input.value = x[key].join('\n');
        else input.value = String(x[key] ?? '');
      }
      schOn[1].checked = !!x.schedule.enabled; freq.value = x.schedule.frequency; time.value = x.schedule.time; wday.value = String(x.schedule.weekday); syncW();
      bpArea.value = bpText(x.brandPlaces ?? []);
      bpCount.textContent = `品牌方所在地对照表（${(x.brandPlaces ?? []).length} 条）`;
    };
    reset.addEventListener('click', () => { fill(structuredClone(d.defaults)); err.textContent = ''; toast('已填回默认值，点「保存设置」才生效'); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      // 数字框里填了不成数字的字，浏览器读出来是空串：要报出来，不能当成「留空」悄悄换成默认值
      const badNum = Object.values(f).find(([, input]) => input.type === 'number' && input.validity.badInput);
      if (badNum) { err.textContent = `「${badNum[2].querySelector('span').textContent}」要填整数，或者留空用默认值`; badNum[1].focus(); return; }
      const body = { schedule: { enabled: schOn[1].checked, frequency: freq.value, time: time.value, weekday: Number(wday.value) } };
      for (const [, [key, input]] of Object.entries(f)) {
        body[key] = input.type === 'checkbox' ? input.checked : input.tagName === 'TEXTAREA' ? input.value.split('\n') : input.type === 'number' ? (input.value.trim() === '' ? '' : Number(input.value)) : input.value;
      }
      body.brandPlaces = bpArea.value; // 服务端按行解析「别名｜公司｜省｜市｜来源」
      save.disabled = true;
      try {
        const r = await api('/api/settings', { method: 'PUT', body });
        d.settings = r.settings;
        meta.reviewer = r.settings.reviewer;
        fill(r.settings);
        toast('设置已保存，下一轮起生效');
      } catch (ex) { err.textContent = ex.message; }
      save.disabled = false;
    });
    view.replaceChildren(head('设置', '改完点页面底部的「保存设置」，下一轮开始生效（正在跑的这一轮不受影响）。只有「搜索关键词」必填（打开定时还要填时间），其余都可以留空，留空怎么算写在每项下面的灰字里。'), form, h('div', { style: 'height:24px' }));
  }

  // ── 启动 ──
  async function boot() {
    try {
      const d = await api('/api/settings');
      meta = { attention: d.attention ?? {}, law: d.law ?? {}, reviewer: d.settings.reviewer ?? '' };
      if (!d.researchSite) document.querySelector('.nav-ext')?.remove(); // 开源版不带研究报告
    } catch { /* 用默认 */ }
    connect();
    refreshNav();
    route();
  }
  boot();
})();

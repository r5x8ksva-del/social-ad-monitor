/* 图表：手写 SVG，按容器实际宽度绘制（窄屏换排版），每张图都有「看表格」和悬停/聚焦提示。
   规格照 dataviz：柱 ≤24px、数据端 4px 圆角、基线端直角；线 2px；点 ≥8px 带 2px 底色圈；网格细实线；文字不用系列色。 */
(function () {
  'use strict';
  const { h, withTip, int, pct } = window.SAM;

  function tableOf(headers, rows, numeric = []) {
    return h('table', null,
      h('thead', null, h('tr', null, headers.map((x, i) => h('th', { class: numeric.includes(i) ? 'n' : null, scope: 'col', text: x })))),
      h('tbody', null, rows.map((r) => h('tr', null, r.map((c, i) => h('td', { class: numeric.includes(i) ? 'n' : null, text: String(c) }))))));
  }

  function card(el, { title, caption, legend, table }) {
    el.classList.add('chart');
    const body = h('div', { class: 'chart-body' });
    const alt = h('div', { class: 'alt', hidden: true });
    let btn = null;
    if (table) {
      alt.appendChild(h('div', { class: 'table-wrap' }, table));
      btn = h('button', { class: 'tbl-toggle', type: 'button', 'aria-expanded': 'false', text: '看表格' });
      btn.addEventListener('click', () => { const open = alt.hidden; alt.hidden = !open; btn.setAttribute('aria-expanded', String(open)); btn.textContent = open ? '收起表格' : '看表格'; });
    }
    el.replaceChildren(
      title ? h('h4', { text: title }) : null,
      caption ? h('p', { class: 'cap', text: caption }) : null,
      body,
      h('div', { class: 'chart-foot' },
        legend ? h('div', { class: 'legend' }, legend.map((l) => h('span', null, h('i', { class: l.box ? 'box' : null, style: `background:${l.color}` }), l.name))) : h('span'),
        btn),
      alt);
    return body;
  }

  // 按容器宽度画，尺寸变了就重画
  function responsive(body, draw) {
    let last = 0;
    const run = () => { const w = Math.round(body.clientWidth); if (w && Math.abs(w - last) > 4) { last = w; body.replaceChildren(draw(w)); } };
    new ResizeObserver(() => requestAnimationFrame(run)).observe(body);
    run();
    document.addEventListener('themechange', () => { last = 0; run(); });
  }

  const barPath = (x, y, w, t, r) => {
    if (w <= 0.5) return '';
    r = Math.min(r, w, t / 2);
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + t - r}Q${x + w},${y + t} ${x + w - r},${y + t}H${x}Z`;
  };
  const svg = (w, hgt, label) => h('svg:svg', { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label });
  const text = (x, y, s, attrs = {}) => h('svg:text', { x, y, ...attrs, text: s });

  // 横向条形（单系列）
  function bars(el, { title, caption, items, format = int, unit = '', max, color = 'var(--series-1)', note }) {
    const table = tableOf(['类别', '数值', ...(note ? [note] : [])], items.map((i) => [i.label, format(i.value) + unit, ...(note ? [i.sub ?? ''] : [])]), [1]);
    const body = card(el, { title, caption, table });
    const mx = max ?? Math.max(1, ...items.map((i) => i.value));
    responsive(body, (W) => {
      const narrow = W < 480, barT = 16, gap = narrow ? 30 : 12;
      const labelW = narrow ? 0 : Math.min(190, Math.round(W * 0.34)), valueW = 70;
      const rowH = narrow ? barT + gap + 4 : 34;
      const H = items.length * rowH + 4;
      const s = svg(W, H, title);
      const x0 = labelW + (narrow ? 0 : 8), span = W - x0 - valueW;
      items.forEach((it, i) => {
        const yRow = i * rowH;
        const y = narrow ? yRow + gap - 6 : yRow + (rowH - barT) / 2;
        const w = span * it.value / mx;
        if (narrow) s.appendChild(text(0, yRow + 14, it.label));
        else s.appendChild(text(labelW, y + barT / 2 + 4, it.label, { 'text-anchor': 'end' }));
        s.appendChild(h('svg:path', { d: barPath(x0, y, w, barT, 4), fill: it.color || color }));
        s.appendChild(text(x0 + w + 6, y + barT / 2 + 4, format(it.value) + unit, { class: 'v' }));
        s.appendChild(withTip(h('svg:rect', { class: 'hit', x: 0, y: yRow, width: W, height: rowH }), [format(it.value) + unit, it.label, ...(it.sub ? [it.sub] : [])]));
      });
      s.appendChild(h('svg:line', { class: 'axis', x1: x0, x2: x0, y1: 0, y2: H }));
      return s;
    });
  }

  // 比例 + 95% 区间（点 + 须）
  function dotCI(el, { title, caption, items }) {
    const fmt = (it) => `${Math.round(it.k / it.n * 100)}%（${Math.round(it.lo * 100)}%–${Math.round(it.hi * 100)}%）`;
    const table = tableOf(['指标', '条数', '比例', '95% 区间'], items.map((it) => [it.label, `${it.k}/${it.n}`, `${Math.round(it.k / it.n * 100)}%`, `${Math.round(it.lo * 100)}%–${Math.round(it.hi * 100)}%`]), [1, 2]);
    const body = card(el, { title, caption, table });
    responsive(body, (W) => {
      const narrow = W < 560;
      const labelW = narrow ? 0 : Math.min(240, Math.round(W * 0.36)), right = narrow ? 8 : 16;
      const rowH = narrow ? 58 : 44, top = 8, axisH = 24;
      const H = top + items.length * rowH + axisH;
      const x0 = labelW + (narrow ? 0 : 12), span = W - x0 - right;
      const X = (p) => x0 + span * p;
      const s = svg(W, H, title);
      for (const g of [0, 0.25, 0.5, 0.75, 1]) {
        s.appendChild(h('svg:line', { class: 'grid', x1: X(g), x2: X(g), y1: top - 4, y2: H - axisH + 4 }));
        s.appendChild(text(X(g), H - 6, `${g * 100}%`, { 'text-anchor': g === 0 ? 'start' : g === 1 ? 'end' : 'middle' }));
      }
      items.forEach((it, i) => {
        const y = top + i * rowH + (narrow ? 38 : rowH / 2);
        if (narrow) s.appendChild(text(0, top + i * rowH + 14, it.label));
        else s.appendChild(text(labelW, y + 4, it.label, { 'text-anchor': 'end' }));
        s.appendChild(h('svg:line', { x1: X(it.lo), x2: X(it.hi), y1: y, y2: y, stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
        for (const e of [it.lo, it.hi]) s.appendChild(h('svg:line', { x1: X(e), x2: X(e), y1: y - 5, y2: y + 5, stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
        s.appendChild(h('svg:circle', { cx: X(it.k / it.n), cy: y, r: 5, fill: 'var(--series-1)', stroke: 'var(--surface)', 'stroke-width': 2 }));
        const p = it.k / it.n;
        const lab = `${Math.round(p * 100)}%`;
        const lx = X(it.hi) + 8, fits = lx + 40 < W;
        s.appendChild(text(fits ? lx : X(it.lo) - 8, y + 4, lab, { class: 'v', 'text-anchor': fits ? 'start' : 'end' }));
        s.appendChild(withTip(h('svg:rect', { class: 'hit', x: 0, y: top + i * rowH, width: W, height: rowH }), [fmt(it), it.label, `${it.k}/${it.n} 条`, ...(it.note ? [it.note] : [])]));
      });
      return s;
    });
  }

  // 混淆矩阵：单色阶（蓝），格子里直接写数（它本身就是表）
  function heat(el, { title, caption, rows, cols, matrix, rowTitle, colTitle }) {
    el.classList.add('chart');
    const mx = Math.max(1, ...matrix.flat());
    const step = (v) => (v === 0 ? null : Math.min(6, 2 + Math.floor((v / mx) * 4.999)));
    const t = h('table', { class: 'heat' },
      h('thead', null,
        h('tr', null, h('th', { class: 'corner', text: `${rowTitle} ＼ ${colTitle}` }), cols.map((c) => h('th', { scope: 'col', text: c })))),
      h('tbody', null, rows.map((r, i) => h('tr', null, h('th', { scope: 'row', text: r }),
        matrix[i].map((v, j) => {
          const st = step(v);
          const td = h('td', { class: 'cell', style: st ? `background:var(--seq-${st})` : 'background:var(--surface-2);color:var(--muted)', text: String(v) });
          td.dataset.step = st ?? 0;
          return withTip(td, [`${v} 条`, `${rowTitle}：${r}`, `${colTitle}：${cols[j]}`]);
        })))));
    el.replaceChildren(title ? h('h4', { text: title }) : null, caption ? h('p', { class: 'cap', text: caption }) : null, h('div', { style: 'overflow-x:auto' }, t));
    const ink = () => {
      for (const td of t.querySelectorAll('td.cell')) {
        if (td.dataset.step === '0') continue;
        const m = getComputedStyle(td).backgroundColor.match(/[\d.]+/g).map(Number);
        const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
        td.style.color = lum < 0.5 ? '#ffffff' : '#121a22';
      }
    };
    requestAnimationFrame(ink);
    document.addEventListener('themechange', () => requestAnimationFrame(ink));
  }

  // 小多图：每种样式一张，横轴字号、纵轴检出率，两条线（视觉模型 / Windows OCR）
  function sensitivity(el, { title, caption, panels, xs, series }) {
    const rows = [];
    for (const p of panels) for (const x of xs) rows.push([p.title, `${x}px`, ...series.map((s) => { const c = p.data[s.key]?.[x]; return c ? `${c.hit}/${c.n}` : '—'; })]);
    const body = card(el, { title, caption, table: tableOf(['样式', '字高', ...series.map((s) => s.name)], rows, [2, 3]), legend: series.map((s) => ({ name: s.name, color: s.color })) });
    responsive(body, (W) => {
      const cols = W < 640 ? 1 : 3, gap = 16, pw = (W - gap * (cols - 1)) / cols, ph = 170;
      const H = Math.ceil(panels.length / cols) * (ph + 34);
      const s = svg(W, H, title);
      panels.forEach((p, i) => {
        const ox = (i % cols) * (pw + gap), oy = Math.floor(i / cols) * (ph + 34);
        const l = ox + 34, r = ox + pw - 10, t = oy + 26, b = oy + ph;
        const X = (x) => l + (r - l) * (x - xs[0]) / (xs.at(-1) - xs[0]);
        const Y = (v) => b - (b - t) * v;
        s.appendChild(text(ox, oy + 14, p.title, { class: 'v' }));
        for (const g of [0, 0.5, 1]) { s.appendChild(h('svg:line', { class: 'grid', x1: l, x2: r, y1: Y(g), y2: Y(g) })); s.appendChild(text(l - 6, Y(g) + 4, `${g * 100}%`, { 'text-anchor': 'end' })); }
        for (const x of xs) s.appendChild(text(X(x), b + 16, `${x}`, { 'text-anchor': 'middle' }));
        s.appendChild(text(r, b + 30, '字高（像素）', { 'text-anchor': 'end' }));
        for (const se of series) {
          const pts = xs.map((x) => ({ x, c: p.data[se.key]?.[x] })).filter((q) => q.c);
          if (!pts.length) continue;
          s.appendChild(h('svg:polyline', { points: pts.map((q) => `${X(q.x)},${Y(q.c.hit / q.c.n)}`).join(' '), fill: 'none', stroke: se.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
          for (const q of pts) {
            s.appendChild(h('svg:circle', { cx: X(q.x), cy: Y(q.c.hit / q.c.n), r: 4, fill: se.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
            s.appendChild(withTip(h('svg:circle', { class: 'hit', cx: X(q.x), cy: Y(q.c.hit / q.c.n), r: 12 }), [`${Math.round(q.c.hit / q.c.n * 100)}%（${q.c.hit}/${q.c.n}）`, `${se.name} · ${p.title} · 字高 ${q.x}px`]));
          }
        }
      });
      return s;
    });
  }

  // 证据时间轴：推广段（荧光笔）、取帧位置（细刻度）、画面文字命中（菱形）、可选缩略图（引线指到时间点）
  function timeline(el, { dur, segments = [], ticks = [], marks = [], thumbs = [], onThumb }) {
    const pctOf = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
    const frames = thumbs.length ? h('div', { class: 'tl-frames' }) : null;
    const bar = h('div', { class: 'tl-bar', role: 'img', 'aria-label': `时长 ${SAM.mmss(dur)}；推广段 ${segments.map((g) => `${SAM.mmss(g.a)}–${SAM.mmss(g.b)}`).join('、') || '无'}` });
    for (const t of ticks) bar.appendChild(h('div', { class: 'tl-tick', style: `left:${pctOf(t)}` }));
    for (const g of segments) {
      const seg = h('div', { class: 'tl-seg', style: `left:${pctOf(g.a)};width:calc(${pctOf(g.b)} - ${pctOf(g.a)})` }, g.label ? h('span', { text: g.label }) : null);
      bar.appendChild(withTip(seg, [`${SAM.mmss(g.a)}–${SAM.mmss(g.b)}`, g.tip || '推广段']));
    }
    // 相邻太近的标记合并成一个（间隔小于全长 2%），提示里写明覆盖的时间段和帧数
    const merged = [];
    for (const m of [...marks].sort((a, b) => a.t - b.t)) {
      const last = merged.at(-1);
      if (last && last.kind === m.kind && m.t - last.t1 < dur * 0.02) { last.t1 = m.t; last.n++; } else merged.push({ ...m, t0: m.t, t1: m.t, n: 1 });
    }
    for (const m of merged) bar.appendChild(withTip(h('div', { class: `tl-mark ${m.kind || ''}`, style: `left:${pctOf((m.t0 + m.t1) / 2)}` }), [m.n > 1 ? `${SAM.mmss(m.t0)}–${SAM.mmss(m.t1)}（${m.n} 帧）` : SAM.mmss(m.t0), m.label]));
    const scale = h('div', { class: 'tl-scale' }, ...[0, 0.25, 0.5, 0.75, 1].map((f) => h('span', { text: SAM.mmss(dur * f) })));
    el.classList.add('tl');
    el.replaceChildren(...[frames, bar, scale].filter(Boolean));
    if (frames) {
      const lines = h('svg:svg', { class: 'tl-lines', style: 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none', 'aria-hidden': 'true' });
      const figs = thumbs.map((th) => {
        const f = h('figure', { class: 'tl-thumb', style: 'margin:0' },
          h('img', { src: th.src, alt: th.alt || '', loading: 'lazy' }),
          h('figcaption', null, h('span', { text: SAM.mmss(th.t) }), h('span', { text: th.caption || '' })));
        f.tabIndex = 0;
        f.setAttribute('role', 'button');
        f.setAttribute('aria-label', `放大 ${SAM.mmss(th.t)} 的画面`);
        const open = () => onThumb && onThumb(th);
        f.addEventListener('click', open);
        f.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
        frames.appendChild(f);
        return f;
      });
      frames.appendChild(lines);
      const layout = () => {
        const W = frames.clientWidth; if (!W) return;
        const visible = figs.filter((f) => getComputedStyle(f).display !== 'none');
        const tw = visible[0]?.offsetWidth || 160, n = visible.length;
        // 缩略图按时间顺序等距排开，引线从缩略图底部连到它在时间轴上的位置
        const slot = n > 1 ? (W - tw) / (n - 1) : 0;
        lines.replaceChildren();
        visible.forEach((f, i) => {
          const cx = n > 1 ? tw / 2 + slot * i : W / 2;
          f.style.left = `${cx}px`;
          const th = thumbs[figs.indexOf(f)];
          const tx = W * Math.max(0, Math.min(1, th.t / dur));
          const y1 = frames.clientHeight, y2 = frames.clientHeight + 18;
          lines.appendChild(h('svg:path', { d: `M${cx},${y1} C${cx},${y1 + 10} ${tx},${y2 - 10} ${tx},${y2}`, fill: 'none', stroke: 'var(--ink-2)', 'stroke-width': 1 }));
        });
      };
      new ResizeObserver(() => requestAnimationFrame(layout)).observe(frames);
      requestAnimationFrame(layout);
    }
  }

  window.CHARTS = { bars, dotCI, heat, sensitivity, timeline, tableOf };
})();

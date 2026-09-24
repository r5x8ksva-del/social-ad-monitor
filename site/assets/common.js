/* 公共工具：建元素（数据里的文字一律走 textContent）、格式化、主题、提示框、放大图、按需加载证据包 */
(function () {
  'use strict';
  const h = (tag, attrs, ...kids) => {
    const el = document.createElementNS(tag.startsWith('svg:') ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml', tag.replace(/^svg:/, ''));
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
    }
    return el;
  };
  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const int = (n) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('zh-CN'));
  const pct = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
  const ci = (pair) => (pair && pair[0] != null ? `${Math.round(pair[0] * 100)}%–${Math.round(pair[1] * 100)}%` : '—');
  const wan = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 1e6 ? 0 : 1)} 万` : int(n));
  const mmss = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60), r = s % 60; return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`; };
  const toSec = (s) => (/^\d+:\d{1,2}(:\d{1,2})?$/.test(String(s)) ? String(s).split(':').reduce((a, x) => a * 60 + Number(x), 0) : null);
  const day = (t) => new Date(t * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const mb = (b) => `${(b / 1048576).toFixed(b > 1e8 ? 0 : 1)} MB`;
  const FMT = { int, pct, pct1: (x) => pct(x, 1), ci, wan, mb, raw: (x) => String(x ?? '—'), k2: (x) => (x == null ? '—' : Number(x).toFixed(2)) };

  // 正文里的 <span data-m="路径" data-f="格式"> 用 METRICS 填数，保证文字和数据同源
  function bindMetrics(root = document) {
    for (const el of root.querySelectorAll('[data-m]')) {
      const v = get(window.METRICS, el.dataset.m);
      el.textContent = (FMT[el.dataset.f || 'int'] || FMT.int)(v);
    }
  }

  // 主题：跟随系统，也可手动切换（只存在本机浏览器里）
  const THEME_KEY = 'sam-theme';
  function applyTheme(t) { if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme'); }
  try { applyTheme(localStorage.getItem(THEME_KEY)); } catch (e) { /* 无痕窗口等情况读不到就跟随系统 */ }
  function initTheme() {
    const btn = document.querySelector('.theme-btn');
    if (!btn) return;
    const isDark = () => (document.documentElement.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
    const label = () => btn.setAttribute('aria-label', isDark() ? '切换到浅色' : '切换到深色');
    label();
    btn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 存不了就只对本页生效 */ }
      label();
      document.dispatchEvent(new CustomEvent('themechange'));
    });
  }

  // 提示框：鼠标和键盘聚焦都会触发；内容用 textContent
  let tipEl;
  function tip(show, target, lines) {
    tipEl = tipEl || document.body.appendChild(h('div', { class: 'tip', role: 'tooltip' }));
    if (!show) { tipEl.classList.remove('on'); return; }
    tipEl.replaceChildren(...lines.map((l, i) => (i === 0 ? h('b', { text: l }) : h('div', { text: l }))));
    const r = target.getBoundingClientRect();
    tipEl.classList.add('on');
    const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 10;
    if (y < 64) y = r.bottom + 10;
    x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
    tipEl.style.left = `${x}px`; tipEl.style.top = `${y}px`;
  }
  function withTip(el, lines) {
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', lines.join('，'));
    const on = () => tip(true, el, lines), off = () => tip(false);
    el.addEventListener('pointerenter', on); el.addEventListener('pointerleave', off);
    el.addEventListener('focus', on); el.addEventListener('blur', off);
    return el;
  }

  // 放大看图
  let box;
  function lightbox(src, caption) {
    if (!box) {
      box = document.body.appendChild(h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': '放大的图片', tabindex: '-1' }));
      const close = () => { box.classList.remove('on'); };
      box.addEventListener('click', close);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }
    box.replaceChildren(h('div', null, h('img', { src, alt: caption || '' }), caption ? h('p', { text: caption }) : null));
    box.classList.add('on');
    box.focus();
  }

  // 证据包按需加载（<script> 注入，file:// 下也能用）
  const loading = {};
  function loadDetail(bvid) {
    window.__V = window.__V || {};
    if (window.__V[bvid]) return Promise.resolve(window.__V[bvid]);
    loading[bvid] = loading[bvid] || new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `data/v/${encodeURIComponent(bvid)}.js`;
      s.onload = () => resolve(window.__V[bvid]);
      s.onerror = () => reject(new Error(`证据包 ${bvid} 没加载到`));
      document.head.appendChild(s);
    });
    return loading[bvid];
  }

  const commercialBadge = (c) => h('span', { class: `badge ${c === '确定' ? 'b-sure' : c === '疑似' ? 'b-maybe' : 'b-none'}`, text: c === '无' ? '无推广' : `推广·${c}` });
  const disclosureBadge = (d, isPromo) => (!isPromo ? null : d === '明示广告' ? h('span', { class: 'badge b-good', text: '写明广告' }) : h('span', { class: 'badge b-crit', text: d === '提到赞助合作' ? '只提到赞助合作' : '未标明广告' }));
  const gradeBadge = (g) => h('span', { class: `badge b-grade ${g}`, title: `线索等级 ${g}`, text: g });
  const biliUrl = (bvid) => `https://www.bilibili.com/video/${bvid}/`;
  const asset = (path) => `../${path}`;

  window.SAM = { h, get, FMT, int, pct, ci, wan, mmss, toSec, day, mb, bindMetrics, initTheme, tip, withTip, lightbox, loadDetail, commercialBadge, disclosureBadge, gradeBadge, biliUrl, asset };
  document.addEventListener('DOMContentLoaded', initTheme);
})();

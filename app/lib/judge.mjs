// 判定相关的纯函数：线索分级、原话核对、画面命中、取帧清单、线索合并。不读写文件和库，方便测试。
// 规则和研究版一致（scripts/m2-label.mjs、m2-review.mjs、m3-vision.mjs、m3-frames.mjs）；研究版脚本留档不动，这里是自动监测用的一份。
import { LAW, disclosureLevel } from '../../src/legal.mjs';
import { RX } from '../../src/rules.mjs';
import { promo, WHOLE_FORMS, toSec, gradeOf } from '../../src/final.mjs';

export const COMMERCIAL = ['确定', '疑似', '无'];
export const FORMS = ['中插', '全片定制', '挂链测评', '评论区带货', '自家推广', '无'];
const UNDISCLOSED = new Set(['未标明广告', '未标明广告_挂链']);

// 大模型输出要有能用的 commercial，否则按解析失败处理（重问一次）
export const validLabel = (out) => !!out && typeof out === 'object' && COMMERCIAL.includes(out.commercial);

// 披露程度、是否挂链、代码判的问题（未标明广告、声称无广告、缺不能代替药物）和线索等级。和 m2-label.mjs 的 grade 相同。
export function gradeLabel(out, x) {
  const commercial = out.commercial === '确定' || out.commercial === '疑似';
  const level = disclosureLevel([x.v.title, x.desc, x.c?.top_text, out.disclosure?.quote]);
  const hasLink = x.pinnedCommerce || /(b23\.tv\/mall|taobao|tmall|jd\.com|小程序|淘口令)/i.test(x.desc);
  const flags = [];
  if (commercial && level !== '明示广告') flags.push({ type: hasLink ? '未标明广告_挂链' : '未标明广告', quote: level === '提到赞助合作' ? '只提到赞助/合作，没写「广告」' : '标题、简介、置顶评论、口播都没有标明' });
  if (out.claims_no_ad && out.claims_no_ad !== '无' && out.commercial === '确定') flags.push({ type: '声称无广告', quote: out.claims_no_ad });
  for (const r of out.risks ?? []) if (LAW[r.type]) flags.push({ type: r.type, quote: r.quote ?? '', time: r.time ?? '' });
  const healthFood = (out.segments ?? []).some((s) => s.product_type === '保健食品');
  const text = [x.lines.join('\n'), x.desc, x.c?.top_text].join('\n');
  if (commercial && healthFood && !/不能代替药物/.test(text)) flags.push({ type: '缺不能代替药物', quote: '推广保健食品，转写、简介、置顶里都没有「本品不能代替药物」' });
  for (const f of flags) f.law = LAW[f.type];
  return { disclosureLevel: level, hasLink, flags, grade: gradeOf(out.commercial, hasLink, flags) };
}

// ── 原话核对（m2-review.mjs）：模型会把转写错字「改正」后当原话，所以要回原材料找 ──
export const norm = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

// 完整出现 → ok；超过 16 字且首尾各 8 字都出现 → 部分；都不行 → 找不到
export function checkQuote(q, corpus) {
  const n = norm(q);
  if (!n || n === '无') return 'ok';
  if (corpus.includes(n)) return 'ok';
  if (n.length > 16 && corpus.includes(n.slice(0, 8)) && corpus.includes(n.slice(-8))) return '部分';
  return '找不到';
}

export function quoteChecks(out, corpusText) {
  const corpus = norm(corpusText);
  const quotes = [
    ...(out.segments ?? []).map((s) => ['推广段', s.quote]),
    ['披露', out.disclosure?.quote],
    ['声称无广告', out.claims_no_ad],
    ...(out.risks ?? []).map((r) => [r.type, r.quote]),
  ];
  return quotes.filter(([, q]) => norm(q) && norm(q) !== '无')
    .map(([kind, quote]) => ({ kind, quote: String(quote).slice(0, 200), status: checkQuote(quote, corpus) }));
}

// ── 画面命中（m3-vision.mjs）：视觉模型只抄字，关键词在这里找 ──
export const AD_RX = /广告|商业推广|推广|赞助|商业合作|合作推广|品牌合作|恰饭|商单|金主|本期视频由|感谢.{0,12}(赞助|支持)|特别鸣谢|sponsor/i;
export const DISCLAIMER_RX = /(不能|不可|不得)(代替|替代)(药|藥)|不代替药/;
export const HEALTH_MARK_RX = /保健食品|蓝帽|国食健|食健备|卫食健/;

// rows：[{ t, texts: [{ text, pos }] | null }]，texts 为 null 表示这一帧没读出来
export function frameHits(rows) {
  const h = { frames: rows.length, read: 0, failed: 0, ad: [], disclaimer: [], efficacy: [], health: [] };
  for (const r of rows) {
    if (!Array.isArray(r.texts)) { h.failed++; continue; }
    h.read++;
    for (const x of r.texts) {
      const text = String(x?.text ?? '').replace(/\s+/g, '');
      if (!text) continue;
      const item = { t: r.t, text: text.slice(0, 80), pos: x.pos ?? '' };
      if (AD_RX.test(text)) h.ad.push(item);
      if (DISCLAIMER_RX.test(text)) h.disclaimer.push(item);
      const eff = text.match(RX.efficacy);
      if (eff) h.efficacy.push({ ...item, word: eff[0] });
      if (HEALTH_MARK_RX.test(text)) h.health.push(item);
    }
  }
  for (const k of ['ad', 'disclaimer', 'efficacy', 'health']) h[k].sort((a, b) => a.t - b.t);
  return h;
}

// ── 取帧清单（m3-frames.mjs）：推广段前后各放 10 秒、整条都在推广的按间隔抽、开头 30 秒、结尾 15 秒；超过 cap 就等距抽 ──
export function wantedFragments({ segments = [], form, dur, fragDur, count, cap = Infinity }) {
  if (!(dur > 0) || !(fragDur > 0) || !(count > 0)) return [];
  const need = new Set();
  const add = (a, b, step) => { for (let t = Math.max(0, a); t <= Math.min(dur - 0.5, b); t += step) need.add(Math.floor(t / fragDur)); };
  const stepFor = (len) => (len <= 300 ? fragDur : len <= 1200 ? 15 : 60);
  add(0, 30, fragDur);
  add(dur - 15, dur, fragDur);
  const segs = segments.map((g) => [toSec(g.start), toSec(g.end)]).filter(([a]) => a !== null).map(([a, b]) => [a, b ?? a]);
  for (const [a, b] of segs) add(a - 10, b + 10, stepFor(b - a));
  if (WHOLE_FORMS.has(form) || !segs.length) add(0, dur, stepFor(dur));
  let list = [...need].filter((i) => i >= 0 && i < count).sort((x, y) => x - y);
  if (list.length > cap) {
    const n = Math.max(1, cap);
    list = [...new Set(Array.from({ length: n }, (_, i) => list[n === 1 ? 0 : Math.round((i * (list.length - 1)) / (n - 1))]))];
  }
  return list;
}

// ── 线索合并：模型初标 + 第二模型 + 原话核对 + 画面命中 + 网页复核 ──
// 自动流程不替人下画面结论：画面上读到「广告」「不能代替药物」「保健食品」只加提醒，等人看图后在复核里确认。
export const ATTENTION = {
  两模型分歧: '两个模型对「有没有推广」判得不一样，先看这条',
  原话核对不上: '模型引用的原话在转写、简介、置顶里找不到（可能改写了错字，或者编的）',
  画面疑似写了广告: '画面上读到「广告」「赞助」之类的字，看图确认后在复核里勾「画面上已写明广告」',
  画面有不能代替药物字样: '画面上读到「不能代替药物」类字样，可能是包装印字，看图确认',
  画面有保健食品标志: '画面上读到「保健食品」「蓝帽子」或批号，模型没按保健食品算，看是否要按第十八条判',
  有画面没读出来: '有截帧视觉模型没读出来，读不出不等于没有，要人看',
};

export function buildLead({ label, second = null, hits = null, review = null }) {
  const out = label.output;
  const rv = review;
  const commercial = rv?.verdict === 'reject' ? '无' : rv?.commercial || out.commercial;
  const isPromo = promo({ commercial });
  const form = isPromo ? rv?.form || out.form : '无';
  const removed = new Set(rv?.removeFlags ?? []);
  let flags = isPromo ? (label.flags ?? []).filter((f) => !removed.has(f.type)).map((f) => ({ ...f, law: f.law ?? LAW[f.type] ?? '' })) : [];
  let disclosure = label.disclosure_level ?? '无';
  const attention = [];
  const secondPromo = second?.output && COMMERCIAL.includes(second.output.commercial) ? promo(second.output) : null;
  if (!rv && secondPromo !== null && secondPromo !== promo(out)) attention.push('两模型分歧');
  if (isPromo && !rv && (label.quotes ?? []).some((q) => q.status === '找不到')) attention.push('原话核对不上');
  if (rv?.frameDisclosed) {
    disclosure = '明示广告';
    flags = flags.filter((f) => !UNDISCLOSED.has(f.type));
  } else if (isPromo && hits?.ad.length) {
    flags = flags.map((f) => (UNDISCLOSED.has(f.type) ? { ...f, quote: `${f.quote}；画面上读到疑似广告字样，待看图确认` } : f));
    if (!rv) attention.push('画面疑似写了广告');
  }
  if (isPromo && !rv && hits) {
    if (hits.disclaimer.length && flags.some((f) => f.type === '缺不能代替药物')) attention.push('画面有不能代替药物字样');
    if (hits.health.length && !(out.segments ?? []).some((s) => s.product_type === '保健食品')) attention.push('画面有保健食品标志');
    if (hits.failed) attention.push('有画面没读出来');
  }
  const status = rv ? (rv.verdict === 'reject' ? '已排除' : rv.verdict === 'modify' ? '已修改' : '已确认') : isPromo ? '待复核' : '无推广';
  return {
    commercial, form, promo: isPromo, status, attention,
    disclosure: isPromo ? disclosure : '—',
    flags,
    grade: gradeOf(commercial, !!label.has_link, flags),
  };
}

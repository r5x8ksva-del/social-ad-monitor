// 最终结论：大模型初标（data/m2/labels）+ 人工复核（data/m2/review.json）+ M3 画面检查（data/m3/frame-review.json）合并。
// M3 起：review.json 里每条都有 pet（人工定的宠物口径，宠物不算健康食品）；画面上确认有「广告」字样的，披露升为明示。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './db.mjs';
import { LAW } from './legal.mjs';

export const promo = (x) => x.commercial === '确定' || x.commercial === '疑似';
// 这几种形式整条视频都在推广，画面检查要覆盖全片
export const WHOLE_FORMS = new Set(['全片定制', '挂链测评', '自家推广', '评论区带货']);
export const toSec = (s) => (/^\d+:\d{1,2}(:\d{1,2})?$/.test(String(s)) ? String(s).split(':').reduce((a, x) => a * 60 + Number(x), 0) : null);
const DISCLOSURE_RANK = { 无: 0, 提到赞助合作: 1, 明示广告: 2 };

// 等级规则和 m2-label.mjs 的 grade 相同
export const gradeOf = (commercial, hasLink, flags) => {
  if (commercial !== '确定' && commercial !== '疑似') return 'C';
  const serious = flags.some((f) => f.type !== '未标明广告' && f.type !== '未标明广告_挂链');
  return commercial === '确定' && (hasLink || serious) ? 'A' : 'B';
};

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback);

export function loadFinal(db) {
  const sample = readJson(join(DATA, 'm2', 'sample.json')).bvids;
  const review = readJson(join(DATA, 'm2', 'review.json'), {});
  const frames = readJson(join(DATA, 'm3', 'frame-review.json'), {});
  return sample.map((s) => {
    const v = db.prepare('SELECT title, author, mid, play, pubdate, duration_s, typename, tags FROM videos WHERE bvid = ?').get(s.bvid);
    const scr = db.prepare('SELECT score, selected, audit FROM screening WHERE bvid = ?').get(s.bvid);
    const path = join(DATA, 'm2', 'labels', `${s.bvid}.json`);
    if (!existsSync(path)) return { ...s, ...v, score: scr?.score, selected: scr?.selected, missing: true };
    const r = JSON.parse(readFileSync(path, 'utf8'));
    const fix = review[s.bvid] ?? {};
    const commercial = fix.commercial ?? r.output?.commercial;
    const textLevel = fix.disclosureLevel ?? r.disclosureLevel;
    const frame = frames[s.bvid] ?? null;
    const frameLevel = frame?.level ?? '无';
    const disclosureLevel = DISCLOSURE_RANK[frameLevel] > DISCLOSURE_RANK[textLevel] ? frameLevel : textLevel;
    // M3 画面证据带来的修正单独放在 fix.m3frames，不算进 M2 复核的改动：
    // segments 覆盖产品类型；removeFlags / addFlags 同 M2；restoreFlags 撤销 M2 里前提已被画面推翻的删除
    const m3f = fix.m3frames ?? {};
    const removed = [...(fix.removeFlags ?? []).filter((t) => !(m3f.restoreFlags ?? []).includes(t)), ...(m3f.removeFlags ?? [])];
    let flags = [...(r.flags ?? []).filter((f) => !removed.includes(f.type)), ...[...(fix.addFlags ?? []), ...(m3f.addFlags ?? [])].map((f) => ({ ...f, law: LAW[f.type] }))];
    // 画面上标了「广告」就不再算「未标明广告」
    if (disclosureLevel === '明示广告') flags = flags.filter((f) => f.type !== '未标明广告' && f.type !== '未标明广告_挂链');
    else if (frameLevel === '提到赞助合作' && textLevel === '无') flags = flags.map((f) => (f.type.startsWith('未标明广告') ? { ...f, quote: '画面上只提到赞助/合作，没写「广告」' } : f));
    return {
      ...s, ...v, score: scr?.score, selected: scr?.selected,
      commercial, form: fix.form ?? r.output?.form, segments: m3f.segments ?? fix.segments ?? r.output?.segments ?? [], m3frames: fix.m3frames ?? null,
      textLevel, frameLevel, frame, disclosureLevel, flags, leadGrade: fix.leadGrade ?? gradeOf(commercial, r.hasLink, flags),
      note: fix.note ?? r.output?.note ?? '', pet: fix.pet ?? null, checked: !!fix.checked, hasLink: r.hasLink,
      initial: { commercial: r.output?.commercial, form: r.output?.form, flags: (r.flags ?? []).map((f) => f.type) },
      corrected: Object.keys(fix).some((k) => !['note', 'checked', 'pet', 'm3', 'm3frames'].includes(k)),
      labelUsage: r.usage?.total_tokens ?? 0, labelModel: r.model ?? null, labelMs: r.ms ?? null,
    };
  });
}

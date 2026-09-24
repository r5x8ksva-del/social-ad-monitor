// 线索：从各步的表里取材料、合并成线索（judge.mjs 的 buildLead）、导出 CSV、拼证据包。流水线最后一步和网页复核都调这里。
// 地区分三种来源分开放：发布地（平台提供 / 人工录入）、内容城市（大模型认出、原话核对过）、品牌方所在地（设置里的对照表）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAW } from '../src/legal.mjs';
import { classifyLinks } from '../src/rules.mjs';
import { buildLead, frameHits } from './lib/judge.mjs';
import { filterablePlaces, matchBrandPlaces, placeLabel } from './lib/places.mjs';

const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const isPromo = (o) => !!o && (o.commercial === '确定' || o.commercial === '疑似');

export function reviewOf(db, bvid) {
  const rv = db.prepare('SELECT * FROM reviews WHERE bvid = ?').get(bvid);
  return rv ? {
    verdict: rv.verdict, commercial: rv.commercial, form: rv.form, removeFlags: parse(rv.remove_flags, []),
    frameDisclosed: !!rv.frame_disclosed, note: rv.note ?? '', reviewer: rv.reviewer ?? '', reviewedAt: rv.reviewed_at,
  } : null;
}

function hitsOf(db, bvid) {
  const fr = db.prepare('SELECT ok FROM frames WHERE bvid = ?').get(bvid);
  if (!fr?.ok) return null;
  return frameHits(db.prepare('SELECT t, texts FROM vision WHERE bvid = ? ORDER BY t').all(bvid).map((v) => ({ t: v.t, texts: parse(v.texts) })));
}

export function leadInputs(db, bvid) {
  const l = db.prepare('SELECT * FROM labels WHERE bvid = ?').get(bvid);
  if (!l?.output) return null;
  const s = db.prepare('SELECT output FROM second_labels WHERE bvid = ?').get(bvid);
  return {
    label: { output: parse(l.output), flags: parse(l.flags, []), disclosure_level: l.disclosure_level, has_link: l.has_link, quotes: parse(l.quotes, []) },
    second: s?.output ? { output: parse(s.output) } : null,
    hits: hitsOf(db, bvid),
    review: reviewOf(db, bvid),
  };
}

// 内容城市（places 表）+ 品牌方所在地（推广品牌对上设置里的对照表）
export function placesOf(db, bvid, x, brandTable = []) {
  const content = parse(db.prepare('SELECT output FROM places WHERE bvid = ?').get(bvid)?.output, []) ?? [];
  const outs = [x.label.output, x.second?.output].filter(isPromo);
  const brands = outs.flatMap((o) => (o.segments ?? []).flatMap((g) => [g.brand, g.product]));
  return { content, brand: matchBrandPlaces(brands, brandTable) };
}

export function refreshLead(db, bvid, runId = null, settings = null) {
  const x = leadInputs(db, bvid);
  if (!x) return null;
  const lead = buildLead(x);
  const places = placesOf(db, bvid, x, settings?.brandPlaces ?? []);
  db.prepare(`INSERT INTO leads (bvid, updated_at, first_run, commercial, form, grade, disclosure, flags, attention, status, promo, places)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET updated_at = excluded.updated_at, first_run = COALESCE(leads.first_run, excluded.first_run),
      commercial = excluded.commercial, form = excluded.form, grade = excluded.grade, disclosure = excluded.disclosure,
      flags = excluded.flags, attention = excluded.attention, status = excluded.status, promo = excluded.promo, places = excluded.places`)
    .run(bvid, new Date().toISOString(), lead.promo ? runId : null, lead.commercial, lead.form, lead.grade, lead.disclosure,
      JSON.stringify(lead.flags), JSON.stringify(lead.attention), lead.status, lead.promo ? 1 : 0, JSON.stringify(places));
  return lead;
}

// ── 列表与导出 ──
export const localDay = (unix) => {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const LIST_SQL = `SELECT l.*, v.title, v.author, v.mid, v.play, v.pubdate, v.duration_s, v.typename, r.reviewer, r.reviewed_at, r.note AS review_note,
  sl.output AS second_output, lb.labeled_at, pl.province AS pub_province, pl.city AS pub_city, pl.source AS pub_source, pl.note AS pub_note, pl.updated_at AS pub_at
  FROM leads l JOIN videos v ON v.bvid = l.bvid LEFT JOIN reviews r ON r.bvid = l.bvid
  LEFT JOIN second_labels sl ON sl.bvid = l.bvid LEFT JOIN labels lb ON lb.bvid = l.bvid LEFT JOIN publish_locations pl ON pl.bvid = l.bvid`;

const pubOf = (r) => (r.pub_province || r.pub_city ? { province: r.pub_province ?? '', city: r.pub_city ?? '', source: r.pub_source ?? '', note: r.pub_note ?? '', at: r.pub_at } : null);
// 参与筛选的内容城市和品牌方城市（分开）
const regionOf = (r) => {
  const pl = parse(r.places, { content: [], brand: [] }) ?? { content: [], brand: [] };
  return { content: filterablePlaces(pl.content).map(({ province, city, role }) => ({ province, city, role })), brand: (pl.brand ?? []).map(({ province, city, brand, company }) => ({ province, city, brand, company })) };
};

export function listLeads(db) {
  return db.prepare(LIST_SQL).all().map((r) => ({
    bvid: r.bvid, title: r.title, author: r.author, mid: r.mid, play: r.play, pubdate: r.pubdate, duration: r.duration_s, typename: r.typename,
    commercial: r.commercial, form: r.form, grade: r.grade, disclosure: r.disclosure, status: r.status, promo: !!r.promo,
    flags: parse(r.flags, []).map((f) => f.type), attention: parse(r.attention, []), firstRun: r.first_run, labeledAt: r.labeled_at,
    second: parse(r.second_output)?.commercial ?? null, reviewer: r.reviewer ?? null, reviewedAt: r.reviewed_at ?? null,
    pub: pubOf(r), region: regionOf(r),
  }));
}

const ORDER = { 待复核: 0, 已修改: 1, 已确认: 2, 已排除: 3, 无推广: 4 };
export function leadsCsv(db, { onlyRun = null } = {}) {
  const rows = db.prepare(`${LIST_SQL} WHERE l.promo = 1 OR l.status = '已排除' OR l.attention != '[]'`).all()
    .filter((r) => !onlyRun || r.first_run === onlyRun)
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.grade.localeCompare(b.grade) || b.play - a.play);
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const header = ['等级', '状态', '需要注意', 'BV号', '链接', '标题', 'UP主', 'UP主mid', '播放', '发布日期', '时长秒', '商业关系', '形式', '披露',
    '疑似问题', '法条', '推广段', '第二模型', '发布地（省）', '发布地（市）', '发布地来源', '内容城市', '品牌方所在地', '复核人', '复核时间', '复核备注', '首次发现'];
  const lines = rows.map((r) => {
    const flags = parse(r.flags, []);
    const segs = parse(db.prepare('SELECT output FROM labels WHERE bvid = ?').get(r.bvid)?.output)?.segments ?? [];
    const pl = parse(r.places, { content: [], brand: [] }) ?? { content: [], brand: [] };
    return [r.grade, r.status, parse(r.attention, []).join('；'), r.bvid, `https://www.bilibili.com/video/${r.bvid}/`, r.title, r.author, r.mid, r.play,
      localDay(r.pubdate), r.duration_s, r.commercial, r.form, r.disclosure,
      flags.map((f) => `${f.type.replace('_挂链', '（挂链）')}${f.quote ? `「${String(f.quote).slice(0, 60)}」` : ''}`).join('；'),
      [...new Set(flags.map((f) => f.law ?? LAW[f.type]).filter(Boolean))].join('；'),
      segs.map((g) => `${g.start}-${g.end} ${g.brand ?? ''} ${g.product ?? ''}`.trim()).join('；'),
      parse(r.second_output)?.commercial ?? '',
      r.pub_province ?? '', r.pub_city ?? '', r.pub_source ?? '',
      filterablePlaces(pl.content).map((x) => `${placeLabel(x)}（${x.role}）`).join('；'),
      (pl.brand ?? []).map((x) => `${placeLabel(x)}（${x.brand}${x.company ? ` · ${x.company}` : ''}）`).join('；'),
      r.reviewer ?? '', r.reviewed_at ?? '', r.review_note ?? '', r.first_run ?? ''].map(esc).join(',');
  });
  return '﻿' + [header.join(','), ...lines].join('\r\n');
}

// 交给平台填发布地的清单：还没有发布地的推广线索（BV 号、链接、标题、UP 主、发布时间，省、市两列留空）
export function locationTemplateCsv(db) {
  const rows = db.prepare(`${LIST_SQL} WHERE l.promo = 1 AND pl.bvid IS NULL ORDER BY v.pubdate DESC`).all();
  const esc = (x) => `"${String(x ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const header = ['BV号', '链接', '标题', 'UP主', 'UP主mid', '发布时间', '省', '市', '备注'];
  const lines = rows.map((r) => [r.bvid, `https://www.bilibili.com/video/${r.bvid}/`, r.title, r.author, r.mid,
    new Date(r.pubdate * 1000).toLocaleString('zh-CN', { hour12: false }), '', '', ''].map(esc).join(','));
  return '﻿' + [header.join(','), ...lines].join('\r\n');
}

// ── 证据包（线索详情） ──
export function leadDetail(db, p, bvid) {
  const v = db.prepare('SELECT * FROM videos WHERE bvid = ?').get(bvid);
  if (!v) return null;
  const lead = db.prepare('SELECT * FROM leads WHERE bvid = ?').get(bvid);
  const l = db.prepare('SELECT * FROM labels WHERE bvid = ?').get(bvid);
  const s = db.prepare('SELECT * FROM second_labels WHERE bvid = ?').get(bvid);
  const c = db.prepare('SELECT * FROM comments WHERE bvid = ?').get(bvid);
  const scr = db.prepare('SELECT * FROM screening WHERE bvid = ?').get(bvid);
  const m = db.prepare('SELECT * FROM media WHERE bvid = ?').get(bvid);
  const fr = db.prepare('SELECT * FROM frames WHERE bvid = ?').get(bvid);
  const pub = db.prepare('SELECT * FROM publish_locations WHERE bvid = ?').get(bvid);
  const plRow = db.prepare('SELECT * FROM places WHERE bvid = ?').get(bvid);
  const vis = new Map(db.prepare('SELECT file, texts, error FROM vision WHERE bvid = ?').all(bvid).map((r) => [r.file, r]));
  const pageFile = join(p.evidence, bvid, 'page.json');
  const page = existsSync(pageFile) ? parse(readFileSync(pageFile, 'utf8')) : null;
  const asrFile = join(p.asr, `${bvid}.json`);
  const asr = existsSync(asrFile) ? parse(readFileSync(asrFile, 'utf8'), { segments: [] }) : null;
  const audioExists = existsSync(join(p.audio, `${bvid}.m4a`));
  const links = parse(c?.top_links, []);
  const pl = parse(lead?.places, { content: [], brand: [] }) ?? { content: [], brand: [] };
  return {
    video: { bvid, title: v.title, author: v.author, mid: v.mid, play: v.play, pubdate: v.pubdate, duration: v.duration_s, typename: v.typename, tags: v.tags, isUnion: !!v.is_union, firstRun: v.first_run },
    screening: scr ? { inScope: !!scr.in_scope, note: scr.scope_note, pet: !!scr.pet, score: scr.score, reasons: parse(scr.reasons, []) } : null,
    pinned: c?.top_text ? { text: c.top_text, links, commerce: classifyLinks(links).commerce > 0, like: c.top_like } : null,
    commentsTotal: c?.total ?? null,
    page: page ? { desc: page.video?.desc ?? v.description ?? '', infoText: page.infoText ?? '', argue: page.rawVideoData?.argue_info?.argue_msg ?? '', staff: page.video?.staff ?? [], tname: page.video?.tname ?? '' } : null,
    media: m ? { fetchedAt: m.fetched_at, audioOk: !!m.audio_ok, audioDeleted: !!m.audio_deleted, audioExists, audioSha256: m.audio_sha256, audioBytes: m.audio_bytes, error: m.error, files: parse(m.files, []), browser: m.browser, script: m.script } : null,
    transcript: asr ? asr.segments.map((x) => [Math.round(x.s * 10) / 10, Math.round(x.e * 10) / 10, x.text]) : null,
    label: l ? { model: l.model, labeledAt: l.labeled_at, output: parse(l.output), flags: parse(l.flags, []), disclosure: l.disclosure_level, hasLink: !!l.has_link, quotes: parse(l.quotes, []), error: l.error } : null,
    second: s ? { model: s.model, labeledAt: s.labeled_at, output: parse(s.output), error: s.error } : null,
    frames: fr ? {
      fetchedAt: fr.fetched_at, ok: !!fr.ok, stream: parse(fr.stream), bytes: fr.bytes, requests: fr.requests, error: fr.error,
      list: parse(fr.frames, []).map((f) => ({ t: f.t, file: f.file, sha256: f.sha256, texts: parse(vis.get(f.file)?.texts), readError: vis.get(f.file)?.error ?? null })),
    } : null,
    hits: hitsOf(db, bvid),
    lead: lead ? { commercial: lead.commercial, form: lead.form, grade: lead.grade, disclosure: lead.disclosure, flags: parse(lead.flags, []), attention: parse(lead.attention, []), status: lead.status, promo: !!lead.promo, firstRun: lead.first_run } : null,
    review: reviewOf(db, bvid),
    region: {
      pub: pub ? { province: pub.province ?? '', city: pub.city ?? '', source: pub.source ?? '', note: pub.note ?? '', at: pub.updated_at, by: pub.by ?? '' } : null,
      content: pl.content ?? [], brand: pl.brand ?? [],
      placesModel: plRow?.model ?? null, placesAt: plRow?.extracted_at ?? null, placesError: plRow?.error ?? null,
    },
  };
}

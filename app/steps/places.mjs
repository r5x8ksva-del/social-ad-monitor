// ⑩ 识别地区：对任一模型判为推广的视频，让小模型（config/models.json 的 location）从标题、标签、简介、置顶评论、
// 口播转写、画面文字里找「商家门店、服务地区、XX同城、厂址」这类明写的城市；代码负责统一名字、去重、回原材料核对原话。
// 这是「内容城市」，不是发布地：B站 游客看不到视频发布地，发布地要平台提供（网页上导入）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODELS } from '../../src/models.mjs';
import { mmss } from '../../src/labeling.mjs';
import { toSec } from '../../src/final.mjs';
import { chat, pool } from '../lib/ark.mjs';
import { cleanPlaces, filterablePlaces, placesPrompt } from '../lib/places.mjs';

const isPromo = (o) => !!o && (o.commercial === '确定' || o.commercial === '疑似');
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };

// 转写太长时只留开头、结尾和推广段前后 30 秒（地点多出现在这几处）
export function transcriptFor(segments, promoSegs, cap = 6000) {
  const line = (l) => `[${mmss(l.s)}] ${l.text}`;
  const all = segments.map(line).join('\n');
  if (all.length <= cap) return all;
  const ranges = promoSegs.map((g) => [toSec(g.start), toSec(g.end)]).filter(([a]) => a != null).map(([a, b]) => [a - 30, (b ?? a) + 30]);
  const keep = new Set([...segments.slice(0, 15), ...segments.slice(-15), ...segments.filter((l) => ranges.some(([a, b]) => l.s >= a && l.s <= b))]);
  return segments.filter((l) => keep.has(l)).map(line).join('\n').slice(0, cap);
}

export function materialsOf(db, p, bvid) {
  const v = db.prepare('SELECT title, tags, description FROM videos WHERE bvid = ?').get(bvid);
  const c = db.prepare('SELECT top_text FROM comments WHERE bvid = ?').get(bvid);
  const lab = db.prepare('SELECT output FROM labels WHERE bvid = ?').get(bvid);
  const sec = db.prepare('SELECT output FROM second_labels WHERE bvid = ?').get(bvid);
  const page = readJson(join(p.evidence, bvid, 'page.json'));
  const asr = existsSync(join(p.asr, `${bvid}.json`)) ? readJson(join(p.asr, `${bvid}.json`), { segments: [] }) : { segments: [] };
  const out = lab?.output ? JSON.parse(lab.output) : null;
  const out2 = sec?.output ? JSON.parse(sec.output) : null;
  const promoSegs = [...(isPromo(out) ? out.segments ?? [] : []), ...(isPromo(out2) ? out2.segments ?? [] : [])];
  const frameTexts = [...new Set(db.prepare('SELECT texts FROM vision WHERE bvid = ? AND texts IS NOT NULL ORDER BY t').all(bvid)
    .flatMap((r) => JSON.parse(r.texts).map((x) => String(x.text ?? '').trim())).filter((t) => t.length >= 2))];
  const m = {
    title: v?.title ?? '', tags: v?.tags ?? '', desc: (page?.video?.desc ?? v?.description ?? '').replace(/\s+/g, ' ').slice(0, 1200),
    pinned: (c?.top_text ?? '').replace(/\s+/g, ' ').slice(0, 800),
    frames: frameTexts.join(' / ').slice(0, 1500),
    transcript: transcriptFor(asr.segments ?? [], promoSegs),
  };
  // 核对原话用全量材料（转写不截断）
  const corpus = [m.title, m.tags, m.desc, m.pinned, frameTexts.join('\n'), (asr.segments ?? []).map((s) => s.text).join('\n')].join('\n');
  return { m, corpus };
}

// 任一模型判为推广，或者复核人把它改成了推广（模型都判无推广时）
export function placesQueue(db) {
  return db.prepare(`SELECT l.bvid, l.output, s.output AS second, r.verdict, r.commercial AS reviewed FROM labels l LEFT JOIN second_labels s ON s.bvid = l.bvid
    LEFT JOIN reviews r ON r.bvid = l.bvid LEFT JOIN places pl ON pl.bvid = l.bvid WHERE l.output IS NOT NULL AND (pl.bvid IS NULL OR pl.output IS NULL)`).all()
    .filter((r) => isPromo(JSON.parse(r.output)) || (r.second && isPromo(JSON.parse(r.second))) || (r.verdict === 'modify' && isPromo({ commercial: r.reviewed })))
    .map((r) => r.bvid);
}

const parseOut = (text) => { try { const o = JSON.parse(String(text).replace(/^```(json)?|```$/gm, '').trim()); return Array.isArray(o?.places) ? o : null; } catch { return null; } };

export async function places(ctx) {
  const { db, p, runId, signal } = ctx;
  const model = MODELS.location ?? MODELS.vision;
  const todo = placesQueue(db);
  if (!todo.length) { ctx.log('没有要识别地区的视频'); return; }
  const save = db.prepare('INSERT OR REPLACE INTO places (bvid, run_id, model, extracted_at, tokens, output, error) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let done = 0, failed = 0, withCity = 0;
  await pool(todo, 4, async (bvid) => {
    const { m, corpus } = materialsOf(db, p, bvid);
    const prompt = placesPrompt(m);
    let res = await chat({ model, content: prompt, maxTokens: 1500, signal, timeoutMs: 120_000 });
    let tokens = res.tokens, out = parseOut(res.text);
    if (!out && !res.error) { res = await chat({ model, content: prompt, maxTokens: 1500, signal, timeoutMs: 120_000 }); tokens += res.tokens; out = parseOut(res.text); }
    ctx.addTokens('places', tokens);
    if (out) {
      const list = cleanPlaces(out, corpus);
      save.run(bvid, runId, model, new Date().toISOString(), tokens, JSON.stringify(list), null);
      if (filterablePlaces(list).length) withCity++;
    } else {
      failed++;
      save.run(bvid, runId, model, new Date().toISOString(), tokens, null, res.error ?? '输出不是规定的 JSON');
    }
    done++;
    ctx.progress(done, todo.length, bvid);
  }, signal);
  Object.assign(ctx.stats, { placesChecked: done - failed, placesFailed: failed, placesWithCity: withCity });
  ctx.log(`识别地区 ${done - failed} 条推广视频，其中 ${withCity} 条认出了商家或服务所在的城市${failed ? `；${failed} 条失败，下一轮再试` : ''}`);
}

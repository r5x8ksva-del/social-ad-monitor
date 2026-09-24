// ⑥ 大模型判定：读转写 + 简介 + 置顶评论，标出推广段、披露原话、疑似问题（提示词和研究版 M2 逐字相同，在 src/labeling.mjs）。
// 法条映射、「未标明广告」「缺不能代替药物」和线索分级由代码判（judge.mjs）；引用的原话自动回原材料核对。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inputs, buildPrompt, parseJson } from '../../src/labeling.mjs';
import { MODELS } from '../../src/models.mjs';
import { chat, pool } from '../lib/ark.mjs';
import { gradeLabel, quoteChecks, validLabel } from '../lib/judge.mjs';

const tryParse = (text) => { try { const o = parseJson(text); return validLabel(o) ? o : null; } catch { return null; } };
export const corpusOf = (x) => [x.v.title, x.desc, x.c?.top_text, ...x.asr.segments.map((s) => s.text)].filter(Boolean).join('\n');

// 模型输出解析不了就再问一次；两次都不行记下错误，下一轮再试
export async function ask(model, prompt, signal) {
  let res = await chat({ model, content: prompt, signal });
  let tokens = res.tokens, out = tryParse(res.text);
  if (!out) {
    const again = await chat({ model, content: prompt, signal });
    tokens += again.tokens;
    out = tryParse(again.text);
    res = again;
  }
  return { out, tokens, ms: res.ms, http: res.http, error: out ? null : res.error ?? `输出不是规定的 JSON：${res.text.slice(0, 200)}` };
}

export async function label(ctx) {
  const { db, p, runId, signal } = ctx;
  const todo = db.prepare(`SELECT s.bvid FROM screening s JOIN media m ON m.bvid = s.bvid LEFT JOIN labels l ON l.bvid = s.bvid
    WHERE s.in_scope = 1 AND m.audio_ok = 1 AND (l.bvid IS NULL OR l.output IS NULL)`).all()
    .map((r) => r.bvid).filter((b) => existsSync(join(p.asr, `${b}.json`)));
  if (!todo.length) { ctx.log('没有待判定的视频'); return; }
  const save = db.prepare(`INSERT OR REPLACE INTO labels (bvid, run_id, model, labeled_at, ms, tokens, output, disclosure_level, has_link, flags, grade, quotes, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let done = 0, failed = 0, promoN = 0;
  await pool(todo, 3, async (bvid) => {
    let x;
    try {
      x = inputs(db, bvid, p.root);
    } catch (e) {
      failed++; done++;
      save.run(bvid, runId, MODELS.label, new Date().toISOString(), 0, 0, null, null, null, null, null, null, `材料读不出来：${e.message}`);
      ctx.log(`${bvid} 材料读不出来：${e.message}`, 'warn');
      return;
    }
    const r = await ask(MODELS.label, buildPrompt(x), signal);
    ctx.addTokens('label', r.tokens);
    if (r.out) {
      const g = gradeLabel(r.out, x);
      save.run(bvid, runId, MODELS.label, new Date().toISOString(), r.ms, r.tokens, JSON.stringify(r.out), g.disclosureLevel, g.hasLink ? 1 : 0,
        JSON.stringify(g.flags), g.grade, JSON.stringify(quoteChecks(r.out, corpusOf(x))), null);
      if (r.out.commercial !== '无') promoN++;
    } else {
      failed++;
      save.run(bvid, runId, MODELS.label, new Date().toISOString(), r.ms, r.tokens, null, null, null, null, null, null, r.error);
      ctx.log(`${bvid} 判定失败：${r.error}`, 'warn');
    }
    done++;
    ctx.progress(done, todo.length, bvid);
  }, signal);
  Object.assign(ctx.stats, { labeled: done - failed, labelFailed: failed, labeledPromo: promoN });
  ctx.log(`判定 ${done - failed} 条，其中模型认为有推广 ${promoN} 条${failed ? `；${failed} 条失败，下一轮再试` : ''}`);
}

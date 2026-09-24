// ⑨ 读画面文字：视觉模型（config/models.json 的 vision）逐帧抄出画面上的全部文字，包括角落小字、水印。
// 模型只负责抄字，不判断是不是广告；找「广告」「不能代替药物」「保健食品」在代码里做（judge.mjs 的 frameHits）。
// 本机 Windows OCR 认不出角落 10 像素的淡字（研究里叠字测试检出率多在 0–55%），所以用视觉模型。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODELS } from '../../src/models.mjs';
import { chat, pool } from '../lib/ark.mjs';

const PROMPT = '逐条抄出这张视频截图上能看到的所有文字，包括角落里很小、很淡的字、水印、贴纸和字幕。按 JSON 输出：{"texts":[{"text":"…","pos":"左上|上方|右上|左侧|中间|右侧|左下|下方|右下|字幕"}]}。只抄画面上真实存在的文字，看不清的字用□代替，不要猜、不要补全、不要解释；没有文字就输出 {"texts":[]}。';

const parseTexts = (raw) => {
  try {
    const t = JSON.parse(String(raw).replace(/^```(json)?|```$/gm, '').trim()).texts;
    return Array.isArray(t) ? t.map((x) => ({ text: String(x?.text ?? '').slice(0, 200), pos: String(x?.pos ?? '') })) : null;
  } catch {
    return null;
  }
};

export async function vision(ctx) {
  const { db, p, signal } = ctx;
  const seen = new Set(db.prepare('SELECT file FROM vision WHERE texts IS NOT NULL').all().map((r) => r.file));
  const jobs = db.prepare('SELECT bvid, frames FROM frames WHERE ok = 1').all()
    .flatMap((r) => JSON.parse(r.frames).map((f) => ({ bvid: r.bvid, t: f.t, file: f.file, sha256: f.sha256 })))
    .filter((j) => !seen.has(j.file));
  if (!jobs.length) { ctx.log('没有待读的画面'); return; }
  ctx.log(`读画面文字 ${jobs.length} 帧（模型 ${MODELS.vision}）`);
  const save = db.prepare(`INSERT OR REPLACE INTO vision (file, bvid, t, sha256, model, read_at, tokens, texts, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let done = 0, failed = 0;
  await pool(jobs, 4, async (job) => {
    const img = readFileSync(join(p.root, job.file)).toString('base64');
    const content = [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } }, { type: 'text', text: PROMPT }];
    let res = await chat({ model: MODELS.vision, content, maxTokens: 1500, signal, timeoutMs: 90_000 });
    let tokens = res.tokens, texts = parseTexts(res.text);
    // 偶尔会吐出一长串「□」把 JSON 撑坏：重读一次
    if (!texts && !res.error) { res = await chat({ model: MODELS.vision, content, maxTokens: 1500, signal, timeoutMs: 90_000 }); tokens += res.tokens; texts = parseTexts(res.text); }
    ctx.addTokens('vision', tokens);
    save.run(job.file, job.bvid, job.t, job.sha256, MODELS.vision, new Date().toISOString(), tokens, texts ? JSON.stringify(texts) : null, texts ? null : res.error ?? '输出不是规定的 JSON');
    if (!texts) failed++;
    done++;
    if (done % 4 === 0 || done === jobs.length) ctx.progress(done, jobs.length, job.bvid);
  }, signal);
  Object.assign(ctx.stats, { visionFrames: done, visionFailed: failed });
  ctx.log(`读了 ${done} 帧${failed ? `，${failed} 帧没读出来（线索上会提醒人看）` : ''}`);
}

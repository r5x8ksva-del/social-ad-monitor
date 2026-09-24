// ⑦ 第二模型交叉检验：换一家公司的模型（config/models.json 的 second，研究里是 DeepSeek V4 Pro），用逐字相同的材料和规则独立再判一遍。
// 它看不到第一个模型的结论。两个模型对「有没有推广」不一致的，线索上标「两模型分歧」，复核时先看。设置里可以关掉。
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { inputs, buildPrompt } from '../../src/labeling.mjs';
import { MODELS } from '../../src/models.mjs';
import { pool } from '../lib/ark.mjs';
import { ask } from './label.mjs';

export async function second(ctx) {
  const { db, p, runId, signal } = ctx;
  const todo = db.prepare(`SELECT l.bvid FROM labels l LEFT JOIN second_labels s ON s.bvid = l.bvid
    WHERE l.output IS NOT NULL AND (s.bvid IS NULL OR s.output IS NULL)`).all()
    .map((r) => r.bvid).filter((b) => existsSync(join(p.asr, `${b}.json`)));
  if (!todo.length) { ctx.log('没有待交叉检验的视频'); return; }
  const save = db.prepare('INSERT OR REPLACE INTO second_labels (bvid, run_id, model, labeled_at, ms, tokens, output, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const first = db.prepare('SELECT output FROM labels WHERE bvid = ?');
  let done = 0, failed = 0, disagree = 0;
  await pool(todo, 3, async (bvid) => {
    const r = await ask(MODELS.second, buildPrompt(inputs(db, bvid, p.root)), signal);
    ctx.addTokens('second', r.tokens);
    save.run(bvid, runId, MODELS.second, new Date().toISOString(), r.ms, r.tokens, r.out ? JSON.stringify(r.out) : null, r.error);
    if (!r.out) { failed++; ctx.log(`${bvid} 交叉检验失败：${r.error}`, 'warn'); }
    else {
      const a = JSON.parse(first.get(bvid).output).commercial !== '无', b = r.out.commercial !== '无';
      if (a !== b) disagree++;
    }
    done++;
    ctx.progress(done, todo.length, bvid);
  }, signal);
  Object.assign(ctx.stats, { secondChecked: done - failed, secondFailed: failed, disagreements: disagree });
  ctx.log(`交叉检验 ${done - failed} 条，两个模型对「有没有推广」不一致 ${disagree} 条${failed ? `；${failed} 条失败，下一轮再试` : ''}`);
}

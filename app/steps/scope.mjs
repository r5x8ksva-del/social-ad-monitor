// ② 划范围：时间窗、时长、品类词、宠物（src/rules.mjs 的 scope / isPet）。
// 时间窗的下限是监测开始的时刻（runner 的 scopeCutoff），不是这一轮的起点：搜索收录晚、这一轮才搜到的新视频也算。
// 研究版里宠物口径是人工写进 review.json 的；自动监测直接用规则（M3 在 116 条样本上和人工 116/116 一致）。
import { scope, isPet } from '../../src/rules.mjs';

export async function scopeStep(ctx) {
  const { db, settings: cfg, since, runId } = ctx;
  const cutoff = ctx.scopeCutoff ?? since;
  const rows = db.prepare('SELECT v.* FROM videos v LEFT JOIN screening s ON s.bvid = v.bvid WHERE s.bvid IS NULL').all();
  const put = db.prepare('INSERT INTO screening (bvid, run_id, in_scope, scope_note, pet, screened_at) VALUES (?, ?, ?, ?, ?, ?)');
  const at = new Date().toISOString();
  const notes = {};
  for (const v of rows) {
    const s = scope(v, cfg, cutoff);
    put.run(v.bvid, runId, s.inScope ? 1 : 0, s.note, isPet(v) ? 1 : 0, at);
    notes[s.note] = (notes[s.note] ?? 0) + 1;
  }
  const inScope = Object.entries(notes).filter(([k]) => k.startsWith('in:')).reduce((a, [, n]) => a + n, 0);
  const NAME = { 'out:窗口外': '监测开始前发布的旧视频','out:太短': `不足 ${cfg.minDurationS} 秒`, 'out:不含品类词': '不含品类词', 'out:宠物': '宠物产品' };
  const out = Object.entries(notes).filter(([k]) => !k.startsWith('in:')).map(([k, n]) => `${NAME[k] ?? k} ${n}`);
  ctx.progress(rows.length, rows.length);
  Object.assign(ctx.stats, { screened: rows.length, inScopeNew: inScope, scopeNotes: notes });
  ctx.log(`新视频 ${rows.length} 条，范围内 ${inScope} 条${out.length ? `；范围外：${out.join('，')}` : ''}`);
}

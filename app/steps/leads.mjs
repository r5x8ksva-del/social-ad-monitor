// ⑩ 汇总线索：每条判定过的视频合并成一条线索（第一个模型 + 第二个模型 + 原话核对 + 画面命中 + 网页复核），
// 导出 CSV（exports/leads-latest.csv 全部，leads-<本轮>.csv 本轮新增）；设置里打开时，删掉无推广视频的音频（哈希留在库里）。
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refreshLead, leadsCsv } from '../leads.mjs';

export async function leads(ctx) {
  const { db, p, settings: cfg, runId } = ctx;
  const bvids = db.prepare('SELECT bvid FROM labels WHERE output IS NOT NULL').all().map((r) => r.bvid);
  let promoNew = 0, attentionNew = 0, deleted = 0;
  const grades = { A: 0, B: 0 };
  const media = db.prepare('SELECT audio_ok, audio_deleted FROM media WHERE bvid = ?');
  const markDeleted = db.prepare('UPDATE media SET audio_deleted = 1 WHERE bvid = ?');
  for (const [i, bvid] of bvids.entries()) {
    const before = db.prepare('SELECT first_run FROM leads WHERE bvid = ?').get(bvid);
    const lead = refreshLead(db, bvid, runId, cfg);
    if (!lead) continue;
    if (lead.promo && !before?.first_run) { promoNew++; grades[lead.grade] = (grades[lead.grade] ?? 0) + 1; }
    const labeledThisRun = db.prepare('SELECT 1 FROM labels WHERE bvid = ? AND run_id = ?').get(bvid, runId);
    if (labeledThisRun && lead.attention.length) attentionNew++;
    // 无推广、两个模型也没分歧、没人复核过：音频用不上了，删掉省空间（转写、哈希、截图都还在）
    const m = media.get(bvid);
    if (cfg.deleteNonPromoAudio && !lead.promo && !lead.attention.length && lead.status === '无推广' && m?.audio_ok && !m.audio_deleted) {
      rmSync(join(p.audio, `${bvid}.m4a`), { force: true });
      markDeleted.run(bvid);
      deleted++;
    }
    if (i % 50 === 0) ctx.progress(i + 1, bvids.length);
  }
  ctx.progress(bvids.length, bvids.length);
  writeFileSync(join(p.exports, 'leads-latest.csv'), leadsCsv(db));
  if (promoNew) writeFileSync(join(p.exports, `leads-${runId}.csv`), leadsCsv(db, { onlyRun: runId }));
  const pending = db.prepare("SELECT COUNT(*) n FROM leads WHERE status = '待复核'").get().n;
  Object.assign(ctx.stats, { leadsNew: promoNew, leadsNewA: grades.A ?? 0, leadsNewB: grades.B ?? 0, attentionNew, audioDeleted: deleted, pendingReview: pending });
  ctx.log(`新线索 ${promoNew} 条（A 级 ${grades.A ?? 0}、B 级 ${grades.B ?? 0}），本轮需要注意 ${attentionNew} 条；待复核累计 ${pending} 条${deleted ? `；删了 ${deleted} 条无推广视频的音频` : ''}`);
}

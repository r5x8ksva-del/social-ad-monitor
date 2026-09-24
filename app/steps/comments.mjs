// ③ 评论区 + 初筛打分：范围内、发布已满 minAgeHours 小时的视频取评论区第一页（游客只看得到置顶 + 3 条热评），
// 然后按 src/rules.mjs 打推广分。分数只决定深度分析的先后，不挡任何视频（初筛只看元数据会漏约三成推广）。
// 刚发布的视频先不取：UP 主常在发布后才补置顶链接，留到下一轮。
import { fetchCommentRow } from '../../src/comments.mjs';
import { screen, priority } from '../../src/rules.mjs';

export async function comments(ctx) {
  const { db, settings: cfg } = ctx;
  const ready = Math.floor(Date.now() / 1000) - cfg.minAgeHours * 3600;
  const pending = db.prepare(`SELECT v.* FROM videos v JOIN screening s ON s.bvid = v.bvid LEFT JOIN comments c ON c.bvid = v.bvid
    WHERE s.in_scope = 1 AND c.bvid IS NULL ORDER BY v.pubdate DESC`).all();
  const due = pending.filter((v) => v.pubdate <= ready);
  const deferred = pending.length - due.length;
  const save = db.prepare(`INSERT OR REPLACE INTO comments (bvid, fetched_at, code, top_text, top_by_up, top_links, top_like, hot, total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const score = db.prepare('UPDATE screening SET score = ?, priority = ?, features = ?, reasons = ? WHERE bvid = ?');
  let done = 0, failed = 0, closed = 0, pinnedLink = 0;
  if (due.length) {
    const client = await ctx.bili();
    for (const v of due) {
      ctx.throwIfAborted();
      const c = await fetchCommentRow(client, v);
      // code 为空 = 请求两次都失败，不存，下一轮再取；code 非 0 = 评论区关闭等，照常存
      if (c.code === null) { failed++; continue; }
      save.run(c.bvid, c.fetched_at, c.code, c.top_text, c.top_by_up, c.top_links, c.top_like, c.hot, c.total);
      const r = screen(v, c, cfg);
      score.run(r.score, priority(r.score, v.play), JSON.stringify(r.features), JSON.stringify(r.reasons), v.bvid);
      done++;
      if (c.code !== 0) closed++;
      if (r.features.top_link) pinnedLink++;
      ctx.progress(done + failed, due.length, v.bvid);
    }
  }
  Object.assign(ctx.stats, { commentsFetched: done, commentsFailed: failed, commentsDeferred: deferred, pinnedLink });
  ctx.log(`取了 ${done} 条视频的评论区（置顶带购物链接 ${pinnedLink}，评论区关闭 ${closed}）${failed ? `，${failed} 条没取到、下一轮再试` : ''}${deferred ? `；${deferred} 条发布不满 ${cfg.minAgeHours} 小时，下一轮再取` : ''}`);
}

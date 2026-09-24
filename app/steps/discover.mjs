// ① 发现：按关键词、按发布时间倒序翻公开搜索结果，翻到这一轮的起点（since）之前为止。
// 接口和翻页规则同研究版 scripts/m1-discover.mjs；游客、限速、留痕都在 src/client.mjs 里。
import { clean, durationSeconds } from '../../src/text.mjs';

export async function discover(ctx) {
  const { db, settings: cfg, since, runId } = ctx;
  const client = await ctx.bili();
  const exists = db.prepare('SELECT 1 FROM videos WHERE bvid = ?');
  const upsert = db.prepare(`
    INSERT INTO videos (bvid, aid, mid, author, title, description, tags, typename, duration_s, pubdate,
                        play, danmaku, replies, favorites, likes, is_union, first_seen, last_seen, first_run, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET
      title = excluded.title, description = excluded.description, tags = excluded.tags,
      play = excluded.play, danmaku = excluded.danmaku, replies = excluded.replies,
      favorites = excluded.favorites, likes = excluded.likes, last_seen = excluded.last_seen, raw = excluded.raw`);
  const addHit = db.prepare('INSERT OR IGNORE INTO hits (bvid, keyword, run_id, page, rank, fetched_at) VALUES (?, ?, ?, ?, ?, ?)');

  let fresh = 0, results = 0;
  const truncated = [];
  for (const [i, kw] of cfg.keywords.entries()) {
    let pages = 0;
    for (let page = 1; page <= cfg.maxPagesPerKeyword; page++) {
      ctx.throwIfAborted();
      const j = await client.getJson(`https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&order=pubdate&page=${page}`);
      if (!j || j.code !== 0) { ctx.log(`「${kw}」第 ${page} 页没取到（${j ? `code ${j.code}` : '请求失败'}），这个词先跳过`, 'warn'); break; }
      const list = j.data?.result ?? [];
      pages = page;
      if (!list.length) break;
      const at = new Date().toISOString();
      for (const [k, v] of list.entries()) {
        if (!exists.get(v.bvid)) fresh++;
        upsert.run(v.bvid, v.aid, v.mid, clean(v.author), clean(v.title), clean(v.description), clean(v.tag), v.typename ?? '',
          durationSeconds(v.duration), v.pubdate, Number(v.play) || 0, Number(v.video_review) || 0, Number(v.review) || 0,
          Number(v.favorites) || 0, Number(v.like) || 0, v.is_union_video ? 1 : 0, at, at, runId, JSON.stringify(v));
        addHit.run(v.bvid, kw, runId, page, (page - 1) * 20 + k + 1, at);
        results++;
      }
      // 结果按发布时间倒序：这一页最新的一条都早于起点，后面就不用翻了
      if (Math.max(...list.map((v) => v.pubdate)) < since) break;
      if (page >= (j.data.numPages ?? cfg.maxPagesPerKeyword) || page === cfg.maxPagesPerKeyword) {
        if (Math.min(...list.map((v) => v.pubdate)) >= since) truncated.push(kw);
        break;
      }
    }
    ctx.progress(i + 1, cfg.keywords.length, `${kw}：${pages} 页`);
  }
  if (truncated.length) ctx.log(`这些词翻到上限还没翻到起点，可能漏了更早的视频：${truncated.join('、')}`, 'warn');
  Object.assign(ctx.stats, { searchResults: results, newVideos: fresh });
  ctx.log(`搜索结果 ${results} 条，其中新视频 ${fresh} 条`);
}

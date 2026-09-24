// 评论区第一页（公开接口，不签名）。游客只拿得到置顶 + 3 条热评。
// 只留文字、点赞数和「置顶是不是 UP 主本人」，不留评论者身份。

// 置顶评论里的链接：正文里的网址 + jump_url 里指向站外/商品的地址（B站自动加的搜索词链接不算）
export function linksOf(reply) {
  if (!reply) return [];
  const inText = reply.content?.message?.match(/https?:\/\/[^\s，。！)）\]]+/g) ?? [];
  const jumps = Object.entries(reply.content?.jump_url ?? {}).flatMap(([k, v]) => [k, v?.pc_url ?? ''])
    .filter((u) => /^https?:\/\//.test(u) && !/search\.bilibili\.com/.test(u));
  return [...new Set([...inText, ...jumps])];
}

// 返回和 comments 表同形状的一行（top_links / hot 是 JSON 字符串）
export async function fetchCommentRow(client, video) {
  const j = await client.getJson(`https://api.bilibili.com/x/v2/reply?type=1&oid=${video.aid}&sort=1&ps=20&pn=1`);
  const top = j?.data?.upper?.top ?? null;
  return {
    bvid: video.bvid,
    fetched_at: new Date().toISOString(),
    code: j?.code ?? null,
    top_text: top ? String(top.content?.message ?? '').slice(0, 1000) : null,
    top_by_up: top ? (String(top.mid) === String(video.mid) ? 1 : 0) : null,
    top_links: JSON.stringify(linksOf(top)),
    top_like: top?.like ?? null,
    hot: JSON.stringify((j?.data?.replies ?? []).map((r) => ({ text: String(r.content?.message ?? '').slice(0, 300), like: r.like ?? 0 }))),
    total: j?.data?.page?.count ?? null,
  };
}

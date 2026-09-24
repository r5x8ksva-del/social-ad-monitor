// 文本小工具：去掉搜索结果里的高亮标签和 HTML 实体、解析时长。
const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };

export function clean(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|quot|#39|lt|gt|nbsp);/g, (m) => ENTITIES[m])
    .trim();
}

// "1:23" / "12:34" / "1:02:03" → 秒
export function durationSeconds(d) {
  if (typeof d === 'number') return d;
  return String(d ?? '').split(':').reduce((sum, part) => sum * 60 + (Number(part) || 0), 0);
}

export const day = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

// 初筛规则：只用公开元数据（标题、简介、标签）和评论区第一页（置顶 + 热评），
// 给「像不像推广」打分，并写出人能读懂的理由。分数只决定谁先进深度采集，不是判定。
// 规则在 M0 之后、看到 M1 数据之前定下；M3 用随机抽样检验它漏了多少，不按 M1 结果回调。

export const RX = {
  disclose: /赞助|合作|推广|广告|恰饭|商单|品牌方|感谢.{0,10}(支持|提供|赞助)|本期视频由|PR礼盒|金主/i,
  link: /b23\.tv|taobao\.com|tmall\.com|tb\.cn|jd\.com|\b3\.cn|pinduoduo|yangkeduo|youzan|weidian|mall\.bilibili|小程序|淘口令|[￥$€₤]\s?[A-Za-z0-9]{8,}\s?[￥$€₤]/i,
  coupon: /券|优惠|折扣|专属|福利|秒杀|到手价|立减|返现|口令|领取|限时|大促|618|双11|双十一/,
  cta: /链接|下单|购买|入手|直达|置顶|橱窗|店铺|同款|私信|咨询|扫码|加微|v信|vx/i,
  review: /推荐|测评|评测|红黑榜|怎么选|如何选|选购|攻略|平价|性价比|好物|清单|盘点|对比|横评|排行|榜单|必买|回购|种草|开箱|实测|自费|避雷|踩雷|智商税|挑选/,
  price: /\d+(\.\d+)?\s*(元|块)|[¥￥]\s?\d/,
  selfShop: /我的(店|店铺|小店)|小店|淘宝店|自家|我家(的)?产品|本店|我们家/,
  crowd: /恰饭|广告|推广|求链接|链接|同款|已下单|下单了|买了/,
  // 不计入推广分，只作为「高风险」标记（广告法第十七条：普通商品不得涉及疾病治疗功能）
  efficacy: /治疗|治愈|根治|降血压|降血糖|降血脂|抗癌|防癌|消炎|杀菌|排毒|溶栓|软化血管|清理血管|修复(肝|胃|肠)|增强免疫|提高免疫|延缓衰老|抗衰老/,
};

// 链接按指向分三类（M0 里一条科普视频的置顶链接是 B站 站内小工具，不能算商业）
const COMMERCE_URL = /b23\.tv\/mall-|mall\.bilibili|gaoneng\.bilibili|taobao|tmall|tb\.cn|jd\.com|jd\.hk|\b3\.cn|pinduoduo|yangkeduo|youzan|weidian|utm_source|ad_platform|campaign_id/i;
const INTERNAL_URL = /(www\.|m\.)?bilibili\.com\/(video|toy|read|opus|bangumi|audio|list)|space\.bilibili\.com|live\.bilibili\.com|search\.bilibili\.com/i;
const URL_RX = /https?:\/\/[^\s，。！)）\]]+|b23\.tv\/[A-Za-z0-9-]+/g;

export function classifyLinks(urls) {
  const out = { commerce: 0, other: 0, internal: 0 };
  for (const u of urls) out[COMMERCE_URL.test(u) ? 'commerce' : INTERNAL_URL.test(u) ? 'internal' : 'other']++;
  return out;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function relevance(video, cfg) {
  const rx = (cfg._relRx ??= new RegExp(cfg.relevanceTerms.map(escape).join('|'), 'i'));
  if (rx.test(video.title)) return 'title';
  if (rx.test(video.tags ?? '')) return 'tags';
  if (rx.test(video.description ?? '')) return 'desc';
  return null;
}

// 宠物产品（2026-09-23 M3 起不算健康食品口径）：看分区、标题、标签。
// 单个「猫」「狗」字不算（M2 样本里有歌手「汀汀猫」），「爬宠」要算（M2 样本里两条爬宠视频原规则没认出来）；
// 「兽医」不能进标题词（动画《山海兽医》里插的是人吃的鱼油）
const PET_TYPES = new Set(['喵星人', '汪星人', '小宠异宠', '动物综合']);
const PET_TITLE = /宠物|爬宠|萌宠|猫咪|猫粮|猫条|猫砂|幼猫|成猫|老猫|小猫|猫猫|猫主子|养猫|狗狗|狗粮|幼犬|犬用|猫用|宠用|狗子|养狗|毛孩子|铲屎|喵星人|汪星人|猫狗|犬猫/;
const PET_TAG = /宠物|萌宠|猫咪|狗狗|喵星人|汪星人|猫粮|狗粮|养猫|养狗|铲屎|犬/;
export function isPet(video) {
  if (PET_TYPES.has(video.typename)) return true;
  return PET_TITLE.test(video.title ?? '') || PET_TAG.test(video.tags ?? '');
}

// 范围：时间窗内、够长、标题/标签/简介里出现品类词（只出现在简介里的也算——赞助商常常只写在简介里）
// excludePets 只影响以后重跑的 M1；现有数据库保留 M1 当时的结果，M3 的统计在报告时再按 isPet 过滤
export function scope(video, cfg, cutoff) {
  if (video.pubdate < cutoff) return { inScope: false, note: 'out:窗口外' };
  if (video.duration_s < cfg.minDurationS) return { inScope: false, note: 'out:太短' };
  const rel = relevance(video, cfg);
  if (!rel) return { inScope: false, note: 'out:不含品类词' };
  if (cfg.excludePets && isPet(video)) return { inScope: false, note: 'out:宠物' };
  return { inScope: true, note: `in:${rel}` };
}

export function findBrands(text, brands) {
  const lower = text.toLowerCase();
  return [...new Set(brands.filter((b) => lower.includes(b.toLowerCase())))];
}

export function screen(video, comment, cfg) {
  const title = video.title ?? '';
  const desc = video.description ?? '';
  const meta = `${title}\n${desc}`;
  const features = {};
  const reasons = [];
  let score = 0;
  const add = (key, weight, reason) => { features[key] = true; score += weight; reasons.push(reason); };

  const top = comment?.top_text ?? '';
  if (top) {
    const links = classifyLinks([...new Set([...(comment.top_links ? JSON.parse(comment.top_links) : []), ...(top.match(URL_RX) ?? [])])]);
    const buyWords = RX.coupon.test(top) || RX.cta.test(top);
    if (links.commerce) add('top_link', 4, '置顶评论带商品/电商/投放链接');
    else if (/小程序|淘口令|[￥$€₤]\s?[A-Za-z0-9]{8,}\s?[￥$€₤]/.test(top)) add('top_link', 4, '置顶评论引导去小程序/淘口令');
    else if (links.other && buyWords) add('top_link', 2.5, '置顶评论带短链接和购买/优惠话术');
    else if (links.other) add('top_other_link', 1.5, '置顶评论带站外/短链接');
    else if (buyWords) add('top_cta', 1.5, '置顶评论有购买/优惠话术');
  }
  const descLinks = classifyLinks(desc.match(URL_RX) ?? []);
  if (descLinks.commerce || /小程序|淘口令|[￥$€₤]\s?[A-Za-z0-9]{8,}\s?[￥$€₤]/.test(desc)) add('desc_link', 3, '简介带购物链接/口令/小程序');
  else if (descLinks.other) add('desc_other_link', 1, '简介带站外/短链接');
  const disclosed = meta.match(RX.disclose);
  if (disclosed) add('disclose', 2, `标题/简介出现「${disclosed[0]}」`);
  if (RX.coupon.test(meta)) add('coupon', 1.5, '标题/简介有优惠话术');
  if (RX.cta.test(desc)) add('cta', 1, '简介有购买引导');
  if (RX.review.test(title)) add('review', 1, '标题是推荐/测评类');
  if (RX.price.test(meta)) add('price', 0.5, '提到价格');
  const brands = findBrands(`${meta}\n${video.tags ?? ''}`, cfg.brands);
  if (brands.length) {
    features.brands = brands;
    score += Math.min(2, 0.5 * brands.length);
    reasons.push(`提到品牌：${brands.slice(0, 4).join('、')}`);
  }
  if (RX.selfShop.test(desc)) add('self_shop', 2, '简介提到自家店铺/产品');
  if (video.is_union) add('union', 1, '联合投稿');
  const hot = comment?.hot ? JSON.parse(comment.hot) : [];
  if (hot.some((h) => RX.crowd.test(h.text))) add('crowd', 0.5, '热评里有人说恰饭/广告/求链接');
  const efficacy = meta.match(RX.efficacy);
  if (efficacy) { features.efficacy = efficacy[0]; reasons.push(`高风险：疑似功效宣称「${efficacy[0]}」`); }
  return { score, features, reasons };
}

// 进深度采集的先后：推广像不像为主，传播量为辅（政府关心的是影响面）
export const priority = (score, play) => (score > 0 ? score + 0.5 * Math.log10(1 + (play || 0)) : 0);

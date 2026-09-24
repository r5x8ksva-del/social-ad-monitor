// 推广判定的提示词和输入材料（M2 豆包初标、M3 DeepSeek 盲标共用，保证两个模型看到的材料和规则逐字相同）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './db.mjs';
import { classifyLinks } from './rules.mjs';
import { MODEL_RISKS } from './legal.mjs';

export const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export const RULES = `你是市场监管部门的广告监测标注员。根据下面这条 B站 视频的转写、简介和置顶评论，判断里面有没有商业推广，按 JSON 输出。

定义：
- commercial（商业关系）：「确定」= 有购物/佣金链接（置顶评论或简介），或明说赞助/合作/广告/恰饭，或推广自己的店铺/产品；「疑似」= 推销话术明显（夸产品并引导购买、报价格优惠、让人去买）但没有上面的硬证据；「无」= 只是提到、讨论、科普某类产品，没有推销。
- form（形式）：「中插」= 视频中间插入的一段推广；「全片定制」= 整期围绕某个品牌/产品做推广；「挂链测评」= 视频内容本身在推荐、测评、盘点产品（一个或多个品牌都算），同时挂购物链接或引导去买；「评论区带货」= 推销和购物链接只出现在置顶评论/简介里，视频内容本身没在推销这些产品（包括视频没有人声的情况）；「自家推广」= 推广自己的店铺、课程、产品；「无」。评论区带货时 segments 可以为空。
- segments：每段推广的起止时间（取转写行开头的时间）、品牌、产品、product_type（只有提到「蓝帽子」「保健食品」「国食健字/卫食健字」批号时才算「保健食品」；营养补充剂、蛋白粉、鱼油等没提到这些的算「普通食品」；药品算「药品」；说不清写「不明」）、最能说明是推广的一句原话。挂链测评可以整段算一段。
- disclosure：推广内容里明示「广告」「赞助」「合作」「恰饭」之类的原话和时间；没有就写「无」。
- claims_no_ad：视频里有没有说自己「没恰饭」「不是广告」「自费」之类，有就摘原话，没有写「无」。
- risks：只在推广内容里找，类型只能从这几个里选：${MODEL_RISKS.join('、')}。「保健食品…」几类只在产品是保健食品时用；「保健食品代言推荐」= UP 主以自己名义推荐保健食品；「健康知识变相广告」= 以健康、养生知识科普的形式推销保健食品；「疾病治疗」= 非药品宣称能治病、用医疗用语；「极限用语」只限「最好、第一、顶级、国家级、最佳、首选」这类绝对化用语，百分比、纯度数字不算；「引证数据」= 用具体数据、实验、认证、调查结果（如「99.99%」「临床验证」「某某院认证」）宣传产品。每条给原话和时间（原话来自置顶评论或简介时，time 写「置顶」或「简介」）。
要求：原话必须是转写里真实出现的文字（可以截短，不要改写）；时间必须来自转写行；没有把握就把 confidence 标「低」；不要猜。
只输出 JSON：
note 不超过 60 字。
{"commercial":"确定|疑似|无","commercial_basis":["…"],"form":"中插|全片定制|挂链测评|评论区带货|自家推广|无","segments":[{"start":"mm:ss","end":"mm:ss","brand":"","product":"","product_type":"保健食品|普通食品|药品|其他|不明","quote":""}],"disclosure":{"quote":"","time":""},"claims_no_ad":"","risks":[{"type":"","quote":"","time":""}],"confidence":"高|中|低","note":""}`;

// root：放 evidence/ 和 asr/ 的目录。研究版用 data/（默认），自动监测传自己的工作区
export function inputs(db, bvid, root = DATA) {
  const v = db.prepare('SELECT * FROM videos WHERE bvid = ?').get(bvid);
  const c = db.prepare('SELECT * FROM comments WHERE bvid = ?').get(bvid);
  const pagePath = join(root, 'evidence', bvid, 'page.json');
  const page = existsSync(pagePath) ? JSON.parse(readFileSync(pagePath, 'utf8')) : null;
  const asr = JSON.parse(readFileSync(join(root, 'asr', `${bvid}.json`), 'utf8'));
  const lines = asr.segments
    .filter((s) => s.text.replace(/[\s.。,，!！?？]/g, '').length >= 2 && !/^(the|yeah|oh|ok|um)\.?$/i.test(s.text.trim()))
    .map((s) => `[${mmss(s.s)}] ${s.text}`);
  const links = classifyLinks(JSON.parse(c?.top_links ?? '[]'));
  return { v, c, page, asr, lines, pinnedCommerce: links.commerce > 0, desc: page?.video?.desc ?? v.description ?? '' };
}

export const buildPrompt = (x) => `标题：${x.v.title}\nUP主：${x.v.author}\n分区：${x.page?.video?.tname || x.v.typename}\n时长：${mmss(x.asr.seconds)}\n简介：${x.desc.replace(/\s+/g, ' ').slice(0, 800) || '（空）'}\n置顶评论：${x.c?.top_text ? x.c.top_text.replace(/\s+/g, ' ').slice(0, 600) : '（无）'}\n置顶评论是否带商品/电商链接：${x.pinnedCommerce ? '是' : '否'}\n\n转写（每行开头是这句话的开始时间；语音识别可能有错字）：\n${x.lines.join('\n') || '（没有识别到人声）'}\n\n${RULES}`;

export const parseJson = (text) => JSON.parse(String(text).replace(/^```(json)?|```$/gm, '').trim());

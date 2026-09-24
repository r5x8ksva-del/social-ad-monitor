// 地区：省市名统一、解析平台提供的发布地表格、品牌方所在地对照、清洗大模型从内容里认出的城市（含原话核对）。纯函数，便于测试。
// 三种来源分开放、分开显示：
//   发布地（publish）——平台按《互联网广告管理办法》第十六条提供，或人工录入；B站 游客看不到，按规定也只标到省。
//   内容城市（content）——视频材料里明写的商家门店、服务地区、「XX同城」等，附原话。
//   品牌方所在地（brand）——推广的品牌按设置里的对照表对上公司所在城市。
import { norm, checkQuote } from './judge.mjs';

export const MUNICIPALITIES = new Set(['北京', '上海', '天津', '重庆', '香港', '澳门']); // 省级、同时就是城市（直辖市和特别行政区）
// 34 个省级行政区（统一后的写法）：大模型认出的「内容城市」必须落在这里面（发布地和对照表不限，境外 IP 属地会写国家）
export const PROVINCES = new Set(['北京', '天津', '上海', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东',
  '河南', '湖北', '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '台湾', '内蒙古', '广西', '西藏', '宁夏', '新疆', '香港', '澳门']);
// 区域说法不是城市（整词比：「黔西南」是真地名，不能因为含「西南」被去掉）
const REGION_WORDS = /^(江浙沪|江浙沪包邮区|包邮区|京津冀|珠三角|长三角|大湾区|粤港澳|粤港澳大湾区|港澳台|华东|华南|华北|华中|西南|西北|东北|全国|全省|国内|海外|境外|本地)$/;
const ETHNIC = ['土家族', '柯尔克孜族', '柯尔克孜', '哈萨克族', '哈萨克', '蒙古族', '蒙古', '景颇族', '傈僳族', '哈尼族', '布依族', '朝鲜族', '苗族', '藏族', '羌族', '彝族', '傣族', '白族', '壮族', '侗族', '回族', '黎族', '畲族'];

export function normProvince(s) {
  return String(s ?? '').replace(/\s+/g, '').replace(/(维吾尔|壮族|回族)?自治区$/, '').replace(/特别行政区$/, '').replace(/[省市]$/, '');
}

export function normCity(s) {
  let t = String(s ?? '').replace(/\s+/g, '').replace(/特别行政区$/, '');
  if (t.endsWith('自治州')) {
    t = t.slice(0, -3);
    for (let changed = true; changed;) {
      changed = false;
      for (const e of ETHNIC) if (t.length > e.length + 1 && t.endsWith(e)) { t = t.slice(0, -e.length); changed = true; }
    }
    return t;
  }
  return t.length > 2 ? t.replace(/(市|地区|盟)$/, '') : t;
}

// 统一后的一处地点；直辖市省和市相同
export function place(province, city) {
  let p = normProvince(province), c = normCity(city);
  if (MUNICIPALITIES.has(c) && !p) p = c;
  if (MUNICIPALITIES.has(p) && !c) c = p;
  return p || c ? { province: p, city: c } : null;
}
export const placeLabel = (x) => (!x ? '' : x.city && x.province && x.city !== x.province ? `${x.province}·${x.city}` : x.city || x.province);
export const provinceKey = (x) => `P:${x.province || '（省不详）'}`;
export const cityKey = (x) => (x.city ? `C:${x.province || ''}/${x.city}` : provinceKey(x));

// 一个格子里写了整个地点（「广东 广州」「广东省广州市」「IP属地：广东」「上海」）时拆成省、市
export function splitPlace(s) {
  const t = String(s ?? '').replace(/^IP属地[：:]\s*/, '').trim();
  if (!t) return null;
  const parts = t.split(/[\s·•,，/|｜\-－]+/).filter(Boolean);
  if (parts.length >= 2) return place(parts[0], parts[1]);
  const m = t.match(/^(.+?(?:省|自治区|特别行政区))(.*)$/);
  if (m) return place(m[1], m[2]);
  const mm = t.match(/^(北京|上海|天津|重庆)市?/);
  if (mm) return place(mm[1], mm[1]);
  if (/(市|自治州|地区|盟)$/.test(t)) return place('', t);
  return place(t, ''); // IP 属地多数只有省
}

// ── 平台提供的发布地表格：BV 号 + 省 + 市（或一列「发布地」）；有没有表头都行；逗号、制表符分隔都行 ──
function splitLine(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const BV_RX = /BV[0-9A-Za-z]{10}/;

export function parseLocationCsv(text, { maxRows = 20000 } = {}) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const rows = [], errors = [];
  if (!lines.length) return { rows, errors: [{ line: 0, msg: '表格是空的' }] };
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : lines[0].includes('，') ? '，' : ',';
  const head = splitLine(lines[0], sep);
  const find = (rx) => head.findIndex((h) => rx.test(h));
  const bvCol = find(/bv/i);
  let col = { bv: bvCol >= 0 ? bvCol : find(/视频|链接/), prov: find(/^省|省份|province/i), city: find(/^市$|^城市|city|^市（|^市\(/i), one: find(/发布地|属地|地址|地点|location/i), note: find(/备注|说明|来源|note/i) };
  let start = 1;
  // 第一行里就有 BV 号，或者认不出 BV 列和地区列：当作没有表头，按「BV 号、省、市、备注」
  if (BV_RX.test(lines[0]) || col.bv < 0 || (col.prov < 0 && col.city < 0 && col.one < 0)) {
    col = { bv: 0, prov: 1, city: 2, one: -1, note: 3 };
    start = 0;
  }
  const cell = (cells, i) => (i >= 0 ? String(cells[i] ?? '').trim() : '');
  const seen = new Map();
  for (let i = start; i < lines.length; i++) {
    if (seen.size >= maxRows) { errors.push({ line: i + 1, msg: `超过 ${maxRows} 行，后面的没导入` }); break; }
    const cells = splitLine(lines[i], sep);
    const bv = cell(cells, col.bv).match(BV_RX)?.[0] ?? cells.join(' ').match(BV_RX)?.[0];
    if (!bv) { errors.push({ line: i + 1, msg: '找不到 BV 号' }); continue; }
    const pv = cell(cells, col.prov), ct = cell(cells, col.city);
    // 只有「省」一格有字时，它可能写了整个地点（「广东省广州市」「IP属地：广东」「广东 广州」）
    const p = ct ? place(pv, ct) : pv ? splitPlace(pv) : splitPlace(cell(cells, col.one));
    if (!p) { errors.push({ line: i + 1, msg: `${bv} 的省和市都是空的` }); continue; }
    seen.set(bv, { bvid: bv, ...p, note: cell(cells, col.note).slice(0, 200) });
  }
  rows.push(...seen.values());
  return { rows, errors };
}

// ── 品牌方所在地对照表：设置里一行一条「别名1/别名2 ｜ 公司名称 ｜ 省 ｜ 市 ｜ 来源」 ──
export function parseBrandTable(input) {
  const errors = [];
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
  const rows = [];
  raw.forEach((item, i) => {
    let r = item;
    if (typeof item === 'string') {
      if (!item.trim() || item.trim().startsWith('#')) return;
      const f = item.split(/\t|\||｜/).map((s) => s.trim());
      if (f.length < 4) { errors.push(`对照表第 ${i + 1} 行要有「别名｜公司｜省｜市｜来源」，用竖线分隔`); return; }
      r = { aliases: f[0], company: f[1], province: f[2], city: f[3], source: f.slice(4).join('｜') };
    }
    const aliases = [...new Set((Array.isArray(r.aliases) ? r.aliases : String(r.aliases ?? '').split(/[/／、,，]/)).map((s) => String(s).trim()).filter((s) => s.length >= 2))];
    const p = place(r.province, r.city);
    if (!aliases.length || !p) { errors.push(`对照表第 ${i + 1} 行缺品牌别名或省市`); return; }
    if (aliases.some((a) => a.length > 30) || String(r.company ?? '').length > 60 || String(r.source ?? '').length > 300) { errors.push(`对照表第 ${i + 1} 行太长`); return; }
    rows.push({ aliases, company: String(r.company ?? '').trim(), ...p, source: String(r.source ?? '').trim() });
  });
  if (rows.length > 500) errors.push('对照表最多 500 行');
  return { rows: rows.slice(0, 500), errors };
}
export const brandTableText = (rows) => rows.map((r) => [r.aliases.join('/'), r.company, r.province, r.city, r.source].join(' ｜ ')).join('\n');

const GENERIC_BRAND = new Set(['不明', '无', '未知', '某品牌', '其他', '多个品牌', '多品牌', '无品牌']);
// brands：模型标出的推广品牌、产品名；别名是品牌字符串的一部分就算对上（不区分大小写、忽略空格）
export function matchBrandPlaces(brands, table) {
  const bs = [...new Set(brands.map((b) => String(b ?? '').toLowerCase().replace(/\s+/g, '')))].filter((b) => b.length >= 2 && !GENERIC_BRAND.has(b));
  const out = new Map();
  for (const row of table) {
    const hit = row.aliases.find((a) => { const x = a.toLowerCase().replace(/\s+/g, ''); return bs.some((b) => b.includes(x)); });
    if (hit && !out.has(row.company || hit)) out.set(row.company || hit, { brand: hit, company: row.company, province: row.province, city: row.city, source: row.source });
  }
  return [...out.values()];
}

// ── 内容城市：大模型从材料里找，代码负责统一名字、去重、回原材料核对原话 ──
export const PLACE_ROLES = ['门店/经营地', '服务地区', '同城标签', '厂址/公司所在地', '其他提及'];
export const FILTER_ROLES = new Set(['门店/经营地', '服务地区', '同城标签', '厂址/公司所在地']); // 「其他提及」只展示、不参与筛选
const ROLE_RANK = Object.fromEntries(PLACE_ROLES.map((r, i) => [r, i]));

export function cleanPlaces(out, corpusText) {
  const corpus = norm(corpusText);
  const best = new Map();
  for (const x of Array.isArray(out?.places) ? out.places : []) {
    const p = place(x?.province, String(x?.city ?? '').replace(/同城$/, ''));
    // 要有城市、省份是国内省级行政区、城市不是「江浙沪」这类区域说法，也不是把省名当城市
    if (!p || !p.city || !PROVINCES.has(p.province) || REGION_WORDS.test(p.city) || (p.city === p.province && !MUNICIPALITIES.has(p.city))) continue;
    const role = PLACE_ROLES.includes(x.role) ? x.role : '其他提及';
    const quote = String(x.quote ?? '').trim().slice(0, 160);
    const nq = norm(quote);
    const status = nq && nq !== '无' ? checkQuote(quote, corpus) : '找不到'; // checkQuote 把空话和「无」当作不用核对，这里不行
    const item = { ...p, role, quote, source: String(x.source ?? '').slice(0, 10), status };
    const key = cityKey(p);
    const prev = best.get(key);
    const better = !prev || (prev.status === '找不到' && status !== '找不到') || (prev.status === status && ROLE_RANK[role] < ROLE_RANK[prev.role]);
    if (better) best.set(key, item);
  }
  return [...best.values()];
}

// 参与筛选的内容城市：角色是经营地、服务地区、同城标签、厂址，并且原话在材料里找得到
export const filterablePlaces = (list) => (list ?? []).filter((x) => FILTER_ROLES.has(x.role) && x.status !== '找不到');

export function placesPrompt(m) {
  return `你在帮市场监管部门给推广视频标地区。下面是一条 B站 推广视频的材料。

标题：${m.title}
标签：${m.tags || '（无）'}
简介：${m.desc || '（空）'}
置顶评论：${m.pinned || '（无）'}
画面上的文字：${m.frames || '（没取帧）'}
口播转写（语音识别，有错字）：
${m.transcript || '（没有人声）'}

找出材料里明确写到的中国城市（地级市、直辖市、县级市都行），只要和推广的商家、门店、产品有关的，按下面分类：
- 门店/经营地：商家、门店、分店、诊所、工作室的地址或所在城市（如「我们店在杭州西湖区」「洛阳线下门店」「武汉分店」）
- 服务地区：只服务或主要服务某个城市（如「仅限上海同城配送」「郑州可以上门」）
- 同城标签：标题或标签里的「XX同城」
- 厂址/公司所在地：生产厂家、公司注册地或总部所在城市（材料里写出来的才算）
- 其他提及：和推广有关、但上面几类都不是的城市（如「我在大连出差时发现的」）。只要说到商家在那个城市有店，就算门店/经营地，哪怕这句话是在招呼当地观众
不算：品牌名里带的地名（「北京同仁堂」不等于在北京）、「北京时间」、「全国」、国外地名、材料里没写需要猜的。
每个城市给一句最能说明的原话（从材料里原样抄一段连续的文字，可以截短，不要改字、不要把几处拼在一起）和出处。没有就输出空列表。
city 用常用简称（写「恩施」不写「恩施土家族苗族自治州」，写「广州」不写「广州市」）。
只输出 JSON：{"places":[{"city":"","province":"","role":"门店/经营地|服务地区|同城标签|厂址/公司所在地|其他提及","quote":"","source":"标题|标签|简介|置顶|口播|画面"}]}`;
}

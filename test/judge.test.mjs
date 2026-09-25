// 判定纯函数：分级、原话核对、画面命中、取帧清单、线索合并
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeLabel, checkQuote, quoteChecks, norm, frameHits, wantedFragments, buildLead, validLabel, ATTENTION } from '../app/lib/judge.mjs';
import { parseSidx } from '../app/lib/media.mjs';

const x = (over = {}) => ({ v: { title: '鱼油怎么选' }, desc: '', c: { top_text: '' }, lines: ['[00:10] 这个鱼油真的好'], pinnedCommerce: false, ...over });
const out = (over = {}) => ({ commercial: '确定', form: '挂链测评', segments: [{ start: '00:10', end: '00:40', product_type: '普通食品', quote: '这个鱼油真的好' }], disclosure: { quote: '', time: '' }, claims_no_ad: '无', risks: [], ...over });

test('有购物链接、没写广告：未标明广告_挂链，A 级', () => {
  const g = gradeLabel(out(), x({ pinnedCommerce: true }));
  assert.equal(g.hasLink, true);
  assert.equal(g.disclosureLevel, '无');
  assert.deepEqual(g.flags.map((f) => f.type), ['未标明广告_挂链']);
  assert.match(g.flags[0].law, /第九条/);
  assert.equal(g.grade, 'A');
});

test('写明「广告」就没有未标明广告；「绝无恰饭」这类否定不算披露', () => {
  assert.deepEqual(gradeLabel(out(), x({ desc: '本期视频含广告' })).flags, []);
  assert.equal(gradeLabel(out(), x({ desc: '绝无恰饭，全部自费' })).disclosureLevel, '无');
});

test('疑似推广、没链接、没其他问题：B 级；无推广：C 级且没有问题', () => {
  assert.equal(gradeLabel(out({ commercial: '疑似' }), x()).grade, 'B');
  const none = gradeLabel(out({ commercial: '无', segments: [] }), x());
  assert.equal(none.grade, 'C');
  assert.deepEqual(none.flags, []);
});

test('保健食品没说「不能代替药物」要标出来；说了就不标', () => {
  const hf = out({ segments: [{ start: '00:10', end: '00:40', product_type: '保健食品', quote: '' }] });
  assert.ok(gradeLabel(hf, x()).flags.some((f) => f.type === '缺不能代替药物'));
  assert.ok(!gradeLabel(hf, x({ lines: ['[00:50] 本品不能代替药物'] })).flags.some((f) => f.type === '缺不能代替药物'));
});

test('模型自己选的风险类型只收法条表里有的', () => {
  const g = gradeLabel(out({ risks: [{ type: '极限用语', quote: '最好的鱼油', time: '00:12' }, { type: '瞎编的类型', quote: 'x' }] }), x());
  assert.deepEqual(g.flags.map((f) => f.type), ['未标明广告', '极限用语']);
});

// B站 按网信办 2026-05 的要求上线的创作者声明，页面数据里是 video.argue_info.argue_msg（字段形状照研究数据里的真实页面，内容是虚构的）
const declared = (msg) => ({ infoText: `鱼油怎么选 1000 0 2026-09-18 12:00:00 ${msg}`, video: { argue_info: { argue_msg: msg, argue_type: 0, argue_link: '' } } });

test('创作者声明「内容含营销信息」：披露记为声明含营销信息，未标明广告的原话如实写，不再说「都没有标明」', () => {
  const g = gradeLabel(out(), x({ pinnedCommerce: true, page: declared('内容含营销信息') }));
  assert.equal(g.disclosureLevel, '声明含营销信息');
  assert.deepEqual(g.flags.map((f) => f.type), ['未标明广告_挂链']); // 法律上仍要显著标明「广告」（办法第九条），声明不等于标明
  assert.equal(g.flags[0].quote, '只有创作者声明「内容含营销信息」，没写「广告」');
  assert.equal(g.grade, 'A');
});

test('创作者声明 + 口播提到赞助：两样都写进原话；写明「广告」仍是明示；「个人观点」类声明不算披露', () => {
  const both = gradeLabel(out({ disclosure: { quote: '感谢品牌方赞助', time: '00:05' } }), x({ page: declared('内容含营销信息') }));
  assert.equal(both.disclosureLevel, '声明含营销信息');
  assert.equal(both.flags[0].quote, '只有创作者声明「内容含营销信息」，另外提到赞助/合作，没写「广告」');
  const ad = gradeLabel(out(), x({ desc: '本期视频含广告', page: declared('内容含营销信息') }));
  assert.equal(ad.disclosureLevel, '明示广告');
  assert.deepEqual(ad.flags, []);
  const opinion = gradeLabel(out(), x({ page: declared('个人观点，仅供参考') }));
  assert.equal(opinion.disclosureLevel, '无');
  assert.equal(opinion.flags[0].quote, '标题、简介、置顶评论、口播都没有标明');
});

test('原话核对：完整、部分、找不到', () => {
  const corpus = norm('今天给大家推荐一款深海鱼油，每天两粒，现在下单立减五十元，链接在评论区置顶');
  assert.equal(checkQuote('推荐一款深海鱼油', corpus), 'ok');
  assert.equal(checkQuote('今天给大家推荐一款超级好的深海鱼油每天两粒', corpus), '部分');
  assert.equal(checkQuote('国家认证的顶级鱼油', corpus), '找不到');
  assert.equal(checkQuote('无', corpus), 'ok');
  const q = quoteChecks(out({ risks: [{ type: '极限用语', quote: '全网最好' }] }), '这个鱼油真的好');
  assert.deepEqual(q.map((r) => [r.kind, r.status]), [['推广段', 'ok'], ['极限用语', '找不到']]);
});

test('validLabel 只认规定的 commercial', () => {
  assert.equal(validLabel({ commercial: '疑似' }), true);
  assert.equal(validLabel({ commercial: 'yes' }), false);
  assert.equal(validLabel(null), false);
});

test('画面命中：广告字样、不能代替药物、保健食品标志、读不出的帧', () => {
  const h = frameHits([
    { t: 10, texts: [{ text: '本视频由 XX 赞助', pos: '右下' }] },
    { t: 5, texts: [{ text: '本品不能代替药物', pos: '左上' }, { text: '国食健注G2020', pos: '中间' }] },
    { t: 15, texts: null },
    { t: 20, texts: [{ text: '增强免疫力', pos: '字幕' }] },
  ]);
  assert.equal(h.read, 3);
  assert.equal(h.failed, 1);
  assert.deepEqual(h.ad.map((a) => a.t), [10]);
  assert.deepEqual(h.disclaimer.map((a) => a.t), [5]);
  assert.deepEqual(h.health.map((a) => a.t), [5]);
  assert.equal(h.efficacy[0].word, '增强免疫');
});

test('取帧清单：推广段前后、开头结尾；超过上限等距抽', () => {
  const list = wantedFragments({ segments: [{ start: '02:00', end: '02:30' }], form: '中插', dur: 600, fragDur: 5, count: 120 });
  assert.ok(list.includes(0) && list.includes(6));        // 开头 30 秒
  assert.ok(list.includes(119));                            // 结尾
  assert.ok(list.includes(22) && list.includes(32));        // 推广段 110–140 秒
  assert.ok(!list.includes(60));                            // 中插：不看整条
  const whole = wantedFragments({ segments: [], form: '全片定制', dur: 3600, fragDur: 5, count: 720, cap: 30 });
  assert.equal(whole.length, 30);
  assert.equal(whole[0], 0);
  assert.equal(whole.at(-1), 719);
  assert.deepEqual(wantedFragments({ segments: [], form: '中插', dur: 0, fragDur: 5, count: 0 }), []);
});

const label = (over = {}) => ({
  output: out(), flags: [{ type: '未标明广告_挂链', quote: '标题、简介、置顶评论、口播都没有标明' }, { type: '极限用语', quote: '最好' }],
  disclosure_level: '无', has_link: 1, quotes: [{ kind: '推广段', quote: '这个鱼油真的好', status: 'ok' }], ...over,
});
const hits = (over = {}) => ({ frames: 3, read: 3, failed: 0, ad: [], disclaimer: [], efficacy: [], health: [], ...over });

test('线索：没复核是待复核；两个模型分歧、原话找不到都要提醒', () => {
  const l = buildLead({ label: label({ quotes: [{ kind: '极限用语', quote: '最好', status: '找不到' }] }), second: { output: { commercial: '无' } } });
  assert.equal(l.status, '待复核');
  assert.equal(l.grade, 'A');
  assert.deepEqual(l.attention, ['两模型分歧', '原话核对不上']);
});

test('线索：模型判无推广但第二个模型判推广，也要提醒（可能漏了）', () => {
  const l = buildLead({ label: label({ output: out({ commercial: '无' }), flags: [] }), second: { output: { commercial: '疑似' } } });
  assert.equal(l.status, '无推广');
  assert.equal(l.promo, false);
  assert.deepEqual(l.attention, ['两模型分歧']);
});

test('线索：创作者声明含营销信息、模型却判无推广，要提醒人看（可能漏了）；复核过就不再提醒', () => {
  const l = buildLead({ label: label({ output: out({ commercial: '无' }), flags: [], disclosure_level: '声明含营销信息' }) });
  assert.equal(l.status, '无推广');
  assert.deepEqual(l.attention, ['声明营销却判无推广']);
  assert.match(ATTENTION['声明营销却判无推广'], /营销信息/);
  const reviewed = buildLead({ label: label({ output: out({ commercial: '无' }), flags: [], disclosure_level: '声明含营销信息' }), review: { verdict: 'reject' } });
  assert.deepEqual(reviewed.attention, []);
  const promoLead = buildLead({ label: label({ disclosure_level: '声明含营销信息' }) });
  assert.ok(!promoLead.attention.includes('声明营销却判无推广'));
  assert.equal(promoLead.disclosure, '声明含营销信息');
});

test('线索：画面读到广告字样只提醒、不自动改结论；复核勾了「画面已写明」才去掉未标明广告', () => {
  const auto = buildLead({ label: label(), hits: hits({ ad: [{ t: 3, text: '广告' }] }) });
  assert.ok(auto.flags.some((f) => f.type === '未标明广告_挂链' && /待看图确认/.test(f.quote)));
  assert.ok(auto.attention.includes('画面疑似写了广告'));
  const reviewed = buildLead({ label: label(), hits: hits({ ad: [{ t: 3, text: '广告' }] }), review: { verdict: 'modify', frameDisclosed: true } });
  assert.equal(reviewed.disclosure, '明示广告');
  assert.ok(!reviewed.flags.some((f) => f.type.startsWith('未标明广告')));
  assert.equal(reviewed.status, '已修改');
  assert.deepEqual(reviewed.attention, []);
});

test('线索：复核「不是推广」→ 已排除、C 级、问题清空；「修改」可以改形式、去掉问题', () => {
  const rej = buildLead({ label: label(), review: { verdict: 'reject' } });
  assert.deepEqual([rej.status, rej.grade, rej.commercial, rej.flags.length], ['已排除', 'C', '无', 0]);
  const mod = buildLead({ label: label(), review: { verdict: 'modify', commercial: '疑似', form: '中插', removeFlags: ['极限用语'] } });
  assert.deepEqual([mod.status, mod.commercial, mod.form, mod.grade], ['已修改', '疑似', '中插', 'B']);
  assert.deepEqual(mod.flags.map((f) => f.type), ['未标明广告_挂链']);
});

test('线索：画面有保健食品标志但模型没按保健食品算、读不出的帧，都提醒人看', () => {
  const l = buildLead({ label: label(), hits: hits({ health: [{ t: 1, text: '蓝帽子' }], failed: 2 }) });
  assert.ok(l.attention.includes('画面有保健食品标志'));
  assert.ok(l.attention.includes('有画面没读出来'));
});

test('sidx 解析：分片大小、起点和时长', () => {
  const b = Buffer.alloc(32 + 2 * 12);
  b.writeUInt32BE(b.length, 0); b.write('sidx', 4);
  b[8] = 0;                                  // version 0
  b.writeUInt32BE(1000, 16);                 // timescale（前面 4 字节 flags + 4 字节 reference_ID）
  b.writeUInt32BE(0, 20); b.writeUInt32BE(7, 24); // earliest_presentation_time、first_offset
  b.writeUInt16BE(2, 30);                    // reference_count（前面 2 字节保留）
  b.writeUInt32BE(1234, 32); b.writeUInt32BE(5000, 36);
  b.writeUInt32BE(4321, 44); b.writeUInt32BE(4800, 48);
  const s = parseSidx(b);
  assert.equal(s.firstOffset, 7);
  assert.deepEqual(s.refs.map((r) => [r.size, r.start, r.dur]), [[1234, 0, 5], [4321, 5, 4.8]]);
});

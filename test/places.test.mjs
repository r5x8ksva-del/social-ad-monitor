// 地区：省市名统一、平台发布地表格解析、品牌方所在地对照、内容城市清洗与原话核对、识别地区用的材料
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normProvince, normCity, place, splitPlace, cityKey, placeLabel, parseLocationCsv, parseBrandTable, brandTableText,
  matchBrandPlaces, cleanPlaces, filterablePlaces, placesPrompt,
} from '../app/lib/places.mjs';
import { transcriptFor, materialsOf, placesQueue } from '../app/steps/places.mjs';
import { paths, openStore } from '../app/store.mjs';

test('省市名统一：去掉省/市/自治区/自治州后缀，直辖市省市相同', () => {
  assert.equal(normProvince('广东省'), '广东');
  assert.equal(normProvince('新疆维吾尔自治区'), '新疆');
  assert.equal(normProvince('广西壮族自治区'), '广西');
  assert.equal(normProvince('宁夏回族自治区'), '宁夏');
  assert.equal(normProvince('内蒙古自治区'), '内蒙古');
  assert.equal(normProvince('香港特别行政区'), '香港');
  assert.equal(normCity('广州市'), '广州');
  assert.equal(normCity('恩施土家族苗族自治州'), '恩施');
  assert.equal(normCity('海西蒙古族藏族自治州'), '海西');
  assert.equal(normCity('延边朝鲜族自治州'), '延边');
  assert.equal(normCity('大兴安岭地区'), '大兴安岭');
  assert.equal(normCity('锡林郭勒盟'), '锡林郭勒');
  assert.equal(normCity('沙市'), '沙市'); // 两个字的不去「市」
  assert.deepEqual(place('', '上海市'), { province: '上海', city: '上海' });
  assert.deepEqual(place('北京市', ''), { province: '北京', city: '北京' });
  assert.equal(place(' ', ''), null);
  assert.equal(placeLabel({ province: '广东', city: '广州' }), '广东·广州');
  assert.equal(placeLabel({ province: '上海', city: '上海' }), '上海');
  assert.equal(cityKey({ province: '广东', city: '' }), 'P:广东');
});

test('一个格子写了整个地点：IP 属地、空格分隔、连写的省市', () => {
  assert.deepEqual(splitPlace('IP属地：广东'), { province: '广东', city: '' });
  assert.deepEqual(splitPlace('广东 广州'), { province: '广东', city: '广州' });
  assert.deepEqual(splitPlace('广东省广州市'), { province: '广东', city: '广州' });
  assert.deepEqual(splitPlace('内蒙古自治区呼和浩特市'), { province: '内蒙古', city: '呼和浩特' });
  assert.deepEqual(splitPlace('上海'), { province: '上海', city: '上海' });
  assert.deepEqual(splitPlace('深圳市'), { province: '', city: '深圳' });
  assert.equal(splitPlace(''), null);
});

test('发布地表格：带表头、BOM、CRLF、引号里的逗号；导出的待查清单填好后能原样导回', () => {
  const a = parseLocationCsv('﻿BV号,省,市,备注\r\n"BV1AAAAAAAAA",广东省,广州市,"函,1"\r\nBV1BBBBBBBBB,上海,,\r\n');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.rows, [
    { bvid: 'BV1AAAAAAAAA', province: '广东', city: '广州', note: '函,1' },
    { bvid: 'BV1BBBBBBBBB', province: '上海', city: '上海', note: '' },
  ]);
  // 网页导出的「待查发布地清单」格式：标题里有中英文逗号，省、市在第 7、8 列
  const tpl = 'BV号,链接,标题,UP主,UP主mid,发布时间,省,市,备注\r\n"BV1AAAAAAAAA","https://www.bilibili.com/video/BV1AAAAAAAAA/","鱼油，测评, 真的","某UP","123","2026/9/20 10:00:00","广东","深圳","平台回函 7 号"';
  assert.deepEqual(parseLocationCsv(tpl).rows, [{ bvid: 'BV1AAAAAAAAA', province: '广东', city: '深圳', note: '平台回函 7 号' }]);
});

test('发布地表格：没有表头、只有一列地点、链接代替 BV 号、制表符分隔', () => {
  assert.deepEqual(parseLocationCsv('BV1AAAAAAAAA,浙江,杭州').rows, [{ bvid: 'BV1AAAAAAAAA', province: '浙江', city: '杭州', note: '' }]);
  // 第一行就是数据、第二列写「IP属地：广东」：不能被当成表头吞掉
  assert.deepEqual(parseLocationCsv('BV1AAAAAAAAA,IP属地：广东\nBV1BBBBBBBBB,广东省深圳市').rows, [
    { bvid: 'BV1AAAAAAAAA', province: '广东', city: '', note: '' },
    { bvid: 'BV1BBBBBBBBB', province: '广东', city: '深圳', note: '' },
  ]);
  assert.deepEqual(parseLocationCsv('BV号\t发布地\nBV1AAAAAAAAA\t广东 广州').rows, [{ bvid: 'BV1AAAAAAAAA', province: '广东', city: '广州', note: '' }]);
  assert.deepEqual(parseLocationCsv('视频链接,省份,城市\nhttps://www.bilibili.com/video/BV1AAAAAAAAA/?p=1,江苏,苏州市').rows, [{ bvid: 'BV1AAAAAAAAA', province: '江苏', city: '苏州', note: '' }]);
  // 标题列在 BV 列前面也认得出 BV 列
  assert.deepEqual(parseLocationCsv('视频标题,BV号,省,市\n鱼油测评,BV1AAAAAAAAA,四川,成都').rows, [{ bvid: 'BV1AAAAAAAAA', province: '四川', city: '成都', note: '' }]);
});

test('发布地表格：坏行报出来、同一个 BV 后面的覆盖前面的、空表', () => {
  const r = parseLocationCsv('BV号,省,市\n没有编号,广东,广州\nBV1AAAAAAAAA,,\nBV1BBBBBBBBB,广东,广州\nBV1BBBBBBBBB,广东,佛山');
  assert.deepEqual(r.errors, [{ line: 2, msg: '找不到 BV 号' }, { line: 3, msg: 'BV1AAAAAAAAA 的省和市都是空的' }]);
  assert.deepEqual(r.rows, [{ bvid: 'BV1BBBBBBBBB', province: '广东', city: '佛山', note: '' }]);
  assert.deepEqual(parseLocationCsv('  \n').errors, [{ line: 0, msg: '表格是空的' }]);
  assert.equal(parseLocationCsv('BV号,省,市\nBV1AAAAAAAAA,广东,广州\nBV1BBBBBBBBB,广东,广州', { maxRows: 1 }).rows.length, 1);
});

test('品牌方所在地对照表：竖线分隔、注释行、别名拆分；对得上品牌才算（不区分大小写、忽略空格）', () => {
  const t = parseBrandTable('# 注释\n汤臣倍健/By Health ｜ 汤臣倍健股份有限公司 ｜ 广东省 ｜ 珠海市 ｜ 官网\n\n只有两段 | 公司');
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0], /第 4 行/);
  const ok = parseBrandTable('汤臣倍健/By Health ｜ 汤臣倍健股份有限公司 ｜ 广东省 ｜ 珠海市 ｜ 官网');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.rows, [{ aliases: ['汤臣倍健', 'By Health'], company: '汤臣倍健股份有限公司', province: '广东', city: '珠海', source: '官网' }]);
  assert.deepEqual(parseBrandTable(brandTableText(ok.rows)).rows, ok.rows); // 设置页显示的文本能原样存回
  assert.deepEqual(parseBrandTable([{ aliases: ['某牌'], company: '', province: '', city: '' }]).errors, ['对照表第 1 行缺品牌别名或省市']);
  const m = matchBrandPlaces(['汤臣倍健 鱼油', 'BYHEALTH', '无', null, '别家'], ok.rows);
  assert.deepEqual(m, [{ brand: '汤臣倍健', company: '汤臣倍健股份有限公司', province: '广东', city: '珠海', source: '官网' }]);
  assert.deepEqual(matchBrandPlaces(['byhealth益生菌'], ok.rows).map((x) => x.city), ['珠海']);
  assert.deepEqual(matchBrandPlaces(['不明', '无'], ok.rows), []);
});

test('内容城市：统一名字、按城市去重留最好的一条、原话回材料核对、只有「经营地/服务地区/同城/厂址」且原话找得到的参与筛选', () => {
  const corpus = '标题：杭州同城 鱼油 线下店\n简介：我们店在杭州西湖区，欢迎到店\n口播：北京的朋友也可以买';
  const list = cleanPlaces({ places: [
    { city: '杭州市', province: '浙江省', role: '其他提及', quote: '杭州同城', source: '标题' },
    { city: '杭州', province: '浙江', role: '门店/经营地', quote: '我们店在杭州西湖区', source: '简介' },
    { city: '北京', province: '', role: '其他提及', quote: '北京的朋友也可以买', source: '口播' },
    { city: '苏州', province: '江苏', role: '服务地区', quote: '苏州可以上门', source: '口播' },   // 材料里没有这句
    { city: '南京', province: '江苏', role: '服务地区', quote: '无', source: '口播' },              // 「无」不算原话
    { city: '', province: '广东', role: '服务地区', quote: '广东', source: '标题' },                  // 只有省：不要
    { city: '成都', province: '四川', role: '瞎编的类别', quote: '线下店', source: '标题' },
  ] }, corpus);
  const by = Object.fromEntries(list.map((x) => [x.city, x]));
  assert.deepEqual(Object.keys(by).sort(), ['北京', '南京', '成都', '杭州', '苏州'].sort());
  assert.equal(by['杭州'].role, '门店/经营地');
  assert.equal(by['杭州'].status, 'ok');
  assert.equal(by['北京'].province, '北京');
  assert.equal(by['苏州'].status, '找不到');
  assert.equal(by['南京'].status, '找不到');
  assert.equal(by['成都'].role, '其他提及');
  assert.deepEqual(filterablePlaces(list).map((x) => x.city), ['杭州']);
  assert.deepEqual(cleanPlaces(null, corpus), []);
  assert.deepEqual(cleanPlaces({ places: 'x' }, corpus), []);
  // 不是国内城市的去掉：区域说法、把省当城市、境外；「黔西南」含「西南」但是真地名；「XX同城」去掉「同城」
  const odd = cleanPlaces({ places: [
    { city: '江浙沪', province: '江苏', role: '服务地区', quote: '只发江浙沪包邮区' },
    { city: '长三角地区', province: '上海', role: '服务地区', quote: '长三角' },
    { city: '广东', province: '广东', role: '服务地区', quote: '广东' },
    { city: '大阪', province: '日本', role: '厂址/公司所在地', quote: '大阪的工厂' },
    { city: '黔西南布依族苗族自治州', province: '贵州省', role: '厂址/公司所在地', quote: '黔西南' },
    { city: '香港', province: '', role: '门店/经营地', quote: '香港' },
    { city: '宁波同城', province: '浙江', role: '同城标签', quote: '宁波同城' },
  ] }, '只发江浙沪包邮区 长三角 广东 大阪的工厂 黔西南 香港 宁波同城');
  assert.deepEqual(odd.map((x) => `${x.province}/${x.city}`), ['贵州/黔西南', '香港/香港', '浙江/宁波']);
  const prompt = placesPrompt({ title: 'T', tags: '', desc: '', pinned: '', frames: '', transcript: '' });
  assert.match(prompt, /品牌名里带的地名/);
  assert.match(prompt, /只输出 JSON/);
});

test('识别地区的材料：转写太长只留开头、结尾和推广段前后；排队只排任一模型判为推广、还没识别过的', () => {
  const segs = Array.from({ length: 400 }, (_, i) => ({ s: i * 3, e: i * 3 + 3, text: `第${i}句话，这里是一些很长的口播内容` }));
  const short = transcriptFor(segs.slice(0, 5), []);
  assert.equal(short.split('\n').length, 5);
  const long = transcriptFor(segs, [{ start: '10:00', end: '10:30' }], 6000);
  assert.ok(long.length <= 6000);
  assert.match(long, /第0句话/);
  assert.match(long, /第200句话/); // 10:00 = 600 秒 = 第 200 句，在推广段里
  assert.doesNotMatch(long, /第100句话/);

  const dir = mkdtempSync(join(tmpdir(), 'sam-places-'));
  try {
    const p = paths(dir);
    const db = openStore(p);
    const addVideo = (bv, title) => db.prepare("INSERT INTO videos (bvid, title, tags, description, pubdate, play) VALUES (?, ?, '鱼油,杭州同城', '简介里写了店在杭州', 1790000000, 1)").run(bv, title);
    const label = (table, bv, commercial) => db.prepare(`INSERT INTO ${table} (bvid, output) VALUES (?, ?)`).run(bv, JSON.stringify({ commercial, segments: commercial === '无' ? [] : [{ start: '00:03', end: '00:09', brand: '某牌' }] }));
    addVideo('BV1AAAAAAAAA', '推广视频'); label('labels', 'BV1AAAAAAAAA', '确定');
    addVideo('BV1BBBBBBBBB', '第二个模型才判推广'); label('labels', 'BV1BBBBBBBBB', '无'); label('second_labels', 'BV1BBBBBBBBB', '疑似');
    addVideo('BV1CCCCCCCCC', '无推广'); label('labels', 'BV1CCCCCCCCC', '无');
    addVideo('BV1DDDDDDDDD', '已经识别过'); label('labels', 'BV1DDDDDDDDD', '确定');
    db.prepare("INSERT INTO places (bvid, output) VALUES ('BV1DDDDDDDDD', '[]')").run();
    addVideo('BV1EEEEEEEEE', '上次识别失败'); label('labels', 'BV1EEEEEEEEE', '确定');
    db.prepare("INSERT INTO places (bvid, output, error) VALUES ('BV1EEEEEEEEE', NULL, 'http 500')").run();
    assert.deepEqual(placesQueue(db).sort(), ['BV1AAAAAAAAA', 'BV1BBBBBBBBB', 'BV1EEEEEEEEE']);
    db.prepare("INSERT INTO reviews (bvid, verdict, commercial) VALUES ('BV1CCCCCCCCC', 'modify', '确定')").run(); // 复核改成推广
    assert.deepEqual(placesQueue(db).sort(), ['BV1AAAAAAAAA', 'BV1BBBBBBBBB', 'BV1CCCCCCCCC', 'BV1EEEEEEEEE']);

    db.prepare("INSERT INTO comments (bvid, top_text) VALUES ('BV1AAAAAAAAA', '置顶：郑州可以上门')").run();
    db.prepare("INSERT INTO vision (file, bvid, t, texts) VALUES ('f1', 'BV1AAAAAAAAA', 5, ?)").run(JSON.stringify([{ text: '洛阳线下门店' }, { text: 'a' }]));
    mkdirSync(p.asr, { recursive: true });
    writeFileSync(join(p.asr, 'BV1AAAAAAAAA.json'), JSON.stringify({ segments: [{ s: 4, e: 6, text: '我们在成都有门店' }] }));
    const { m, corpus } = materialsOf(db, p, 'BV1AAAAAAAAA');
    assert.equal(m.title, '推广视频');
    assert.equal(m.pinned, '置顶：郑州可以上门');
    assert.equal(m.frames, '洛阳线下门店'); // 太短的（一个字）不要
    assert.equal(m.transcript, '[00:04] 我们在成都有门店');
    assert.equal(m.desc, '简介里写了店在杭州');
    for (const s of ['推广视频', '杭州同城', '郑州可以上门', '洛阳线下门店', '我们在成都有门店']) assert.ok(corpus.includes(s), s);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

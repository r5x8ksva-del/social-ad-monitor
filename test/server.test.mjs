// 接口测试：临时工作区里放一条判定过的视频，起网页服务，测状态、线索、复核、设置、导出和安全检查。不联网、不跑流水线。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../src/db.mjs';
import { paths, openStore } from '../app/store.mjs';
import { refreshLead } from '../app/leads.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sam-server-'));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BV = 'BV1TestAbcde';
let server;

function seed() {
  const db = openStore(paths(dir));
  db.prepare(`INSERT INTO videos (bvid, aid, mid, author, title, description, tags, typename, duration_s, pubdate, play, is_union, first_seen, last_seen, first_run)
    VALUES (?, 1, 2, '某UP主', '鱼油测评：这款真的好', '链接在置顶', '鱼油', '健康', 300, 1790000000, 12345, 0, 'x', 'x', 'run-20260924-030000')`).run(BV);
  db.prepare("INSERT INTO screening (bvid, run_id, in_scope, scope_note, pet, score, priority, features, reasons) VALUES (?, 'r', 1, 'in:title', 0, 5, 7, '{}', '[\"置顶评论带商品链接\"]')").run(BV);
  db.prepare("INSERT INTO comments (bvid, fetched_at, code, top_text, top_by_up, top_links, top_like, hot, total) VALUES (?, 'x', 0, '优惠链接 https://b23.tv/mall-abc', 1, '[\"https://b23.tv/mall-abc\"]', 3, '[]', 10)").run(BV);
  const output = { commercial: '确定', form: '挂链测评', segments: [{ start: '00:10', end: '01:00', brand: '某牌', product: '鱼油', product_type: '普通食品', quote: '这款真的好' }], disclosure: { quote: '', time: '' }, claims_no_ad: '无', risks: [{ type: '极限用语', quote: '最好的鱼油', time: '00:20' }], confidence: '高', note: '' };
  const flags = [{ type: '未标明广告_挂链', quote: '标题、简介、置顶评论、口播都没有标明', law: 'x' }, { type: '极限用语', quote: '最好的鱼油', time: '00:20', law: 'y' }];
  db.prepare(`INSERT INTO labels (bvid, run_id, model, labeled_at, ms, tokens, output, disclosure_level, has_link, flags, grade, quotes)
    VALUES (?, 'run-20260924-030000', 'm', '2026-09-24T03:10:00Z', 1000, 3000, ?, '无', 1, ?, 'A', '[]')`).run(BV, JSON.stringify(output), JSON.stringify(flags));
  refreshLead(db, BV, 'run-20260924-030000');
  db.close?.();
}

// 用 node:http 发请求：fetch 不让改 Host 头
function call(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = request({ host: '127.0.0.1', port: PORT, method, path, headers: { Host: `127.0.0.1:${PORT}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

before(async () => {
  seed();
  mkdirSync(join(dir, 'frames', BV), { recursive: true });
  writeFileSync(join(dir, 'frames', BV, 't00010.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  // 工作区路径故意用正斜杠传：Windows 上 C:/… 和 C:\… 混用时，越界检查不能误判
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'app', 'server.mjs')], {
    env: { ...process.env, SAM_WORKSPACE: dir.replace(/\\/g, '/'), SAM_PORT: String(PORT), SAM_NO_SCHEDULE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('服务没起来')), 15000);
    server.stdout.on('data', (c) => { if (String(c).includes('自动监测网页')) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`服务退出了 ${code}`)));
  });
});

after(async () => {
  if (server && server.exitCode === null) await new Promise((r) => { server.on('exit', r); server.kill(); });
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('首页和状态', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /text\/html/);
  const s = await call('GET', '/api/status');
  assert.equal(s.status, 200);
  assert.equal(s.json.running, null);
  assert.equal(s.json.env.length, 4);
  assert.equal(s.json.workspace.root, dir);
  assert.equal(s.json.schedule.enabled, false);
});

test('证据文件：工作区里的截帧能读，Range 请求返回 206', async () => {
  const img = await call('GET', `/ws/frames/${BV}/t00010.jpg`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/jpeg');
  const part = await call('GET', `/ws/frames/${BV}/t00010.jpg`, { headers: { Range: 'bytes=0-1' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 0-1/4');
});

test('线索列表、证据详情、导出', async () => {
  const list = await call('GET', '/api/leads?view=pending');
  assert.equal(list.status, 200);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.rows[0].bvid, BV);
  assert.equal(list.json.rows[0].grade, 'A');
  assert.equal(list.json.counts.pending, 1);
  const d = await call('GET', `/api/leads/${BV}`);
  assert.equal(d.status, 200);
  assert.equal(d.json.lead.status, '待复核');
  assert.equal(d.json.pinned.commerce, true);
  assert.equal((await call('GET', '/api/leads/BV1Nothing000')).status, 404);
  const csv = await call('GET', '/api/export/leads.csv');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.startsWith('﻿等级,状态'));
  assert.ok(csv.text.includes(BV));
});

test('复核：校验、确认、修改、撤销', async () => {
  const path = `/api/leads/${BV}/review`;
  assert.equal((await call('POST', path, { body: { verdict: 'maybe', reviewer: '甲' } })).status, 400);
  assert.equal((await call('POST', path, { body: { verdict: 'confirm' } })).status, 400);                    // 没填复核人
  assert.equal((await call('POST', path, { body: { verdict: 'modify', reviewer: '甲' } })).status, 400);     // 什么都没改
  assert.equal((await call('POST', path, { body: { verdict: 'modify', reviewer: '甲', removeFlags: ['瞎编'] } })).status, 400);
  const ok = await call('POST', path, { body: { verdict: 'confirm', reviewer: '甲', note: '看过' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.lead.status, '已确认');
  assert.equal(ok.json.review.reviewer, '甲');
  const mod = await call('POST', path, { body: { verdict: 'modify', reviewer: '乙', commercial: '疑似', removeFlags: ['极限用语'] } });
  assert.equal(mod.json.lead.status, '已修改');
  assert.equal(mod.json.lead.grade, 'B');
  assert.deepEqual(mod.json.lead.flags.map((f) => f.type), ['未标明广告_挂链']);
  const rej = await call('POST', path, { body: { verdict: 'reject', reviewer: '乙' } });
  assert.equal(rej.json.lead.status, '已排除');
  const undo = await call('DELETE', path, { body: {} });
  assert.equal(undo.status, 200);
  assert.equal(undo.json.lead.status, '待复核');
  assert.equal(undo.json.review, null);
});

test('设置：不合格的整份不存，合格的存下', async () => {
  const bad = await call('PUT', '/api/settings', { body: { keywords: [], maxDeepPerRun: 0 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /关键词/);
  const good = await call('PUT', '/api/settings', { body: { maxDeepPerRun: 20, reviewer: '甲', schedule: { enabled: true, time: '04:30' } } });
  assert.equal(good.status, 200);
  assert.equal(good.json.settings.maxDeepPerRun, 20);
  // 选填的数字留空：按默认值存；品类词留空也能存
  const blank = await call('PUT', '/api/settings', { body: { maxDeepPerRun: '', minAgeHours: '', relevanceTerms: [''] } });
  assert.equal(blank.status, 200);
  assert.equal(blank.json.settings.maxDeepPerRun, blank.json.defaults.maxDeepPerRun);
  assert.equal(blank.json.settings.minAgeHours, blank.json.defaults.minAgeHours);
  assert.deepEqual(blank.json.settings.relevanceTerms, []);
  const s = await call('GET', '/api/status');
  assert.equal(s.json.schedule.enabled, true);
  assert.equal(s.json.schedule.due, false);   // 刚打开定时不会立刻跑
  assert.ok(s.json.schedule.next);
});

test('安全：外来 Host、外来 Origin、非 JSON 提交、越界读文件都拒绝', async () => {
  assert.equal((await call('GET', '/api/status', { headers: { Host: 'evil.example:80' } })).status, 403);
  assert.equal((await call('POST', '/api/runs/stop', { body: {}, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/runs/stop', { body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.ok([403, 404].includes((await call('GET', '/ws/audio/../monitor.sqlite')).status));   // URL 解析会先消掉 ..
  assert.equal((await call('GET', '/ws/audio/..%2F..%2Fsecret.png')).status, 403);
  assert.equal((await call('GET', '/ws/logs/requests.jsonl')).status, 404);
  assert.equal((await call('GET', '/api/runs/run-19990101-000000')).status, 404);
  assert.equal((await call('POST', '/api/runs/stop', { body: {} })).json.stopped, false);
});

test('发布地：导出待查清单、导入表格、单条录入与清除；按发布地筛选', async () => {
  const tpl = await call('GET', '/api/locations/template.csv');
  assert.equal(tpl.status, 200);
  assert.match(tpl.headers['content-type'], /text\/csv/);
  assert.ok(tpl.text.startsWith('﻿BV号,链接,标题'));
  assert.ok(tpl.text.includes(BV));

  assert.equal((await call('POST', '/api/locations/import', { body: { text: '' } })).status, 400);
  const imp = await call('POST', '/api/locations/import', { body: { text: `BV号,省,市,备注\n${BV},广东省,广州市,函-1\nBV1Unknown00,浙江,杭州,\n坏行,,,`, source: '平台依法提供', by: '甲' } });
  assert.equal(imp.status, 200);
  assert.deepEqual([imp.json.imported, imp.json.updated, imp.json.unknown, imp.json.errorCount], [2, 0, 1, 1]);

  const byCity = await call('GET', `/api/leads?view=all&pub=${encodeURIComponent('C:广东/广州')}`);
  assert.equal(byCity.json.total, 1);
  const pub = byCity.json.rows[0].pub;
  assert.deepEqual([pub.province, pub.city, pub.source, pub.note], ['广东', '广州', '平台依法提供', '函-1']);
  assert.deepEqual(byCity.json.facets.pub.provinces.map((x) => [x.value, x.n, x.cities.map((c) => c.value)]), [['P:广东', 1, ['C:广东/广州']]]);
  assert.equal(byCity.json.facets.pub.none, 0);
  const total = (qs) => call('GET', `/api/leads?view=all&${qs}`).then((r) => r.json.total);
  assert.equal(await total(`pub=${encodeURIComponent('P:广东')}`), 1);
  assert.equal(await total(`pub=${encodeURIComponent('P:浙江')}`), 0);
  assert.equal(await total('pub=none'), 0);
  assert.ok(!(await call('GET', '/api/locations/template.csv')).text.includes(BV)); // 有了发布地就不在待查清单里
  assert.equal((await call('POST', '/api/locations/import', { body: { text: `${BV},广东,深圳` } })).json.updated, 1);

  const path = `/api/leads/${BV}/location`;
  assert.equal((await call('PUT', path, { body: { province: '', city: ' ' } })).status, 400);
  assert.equal((await call('PUT', '/api/leads/BV1Nothing00/location', { body: { province: '上海' } })).status, 404);
  const put = await call('PUT', path, { body: { province: '上海市', note: '电话核实', by: '乙' } });
  assert.equal(put.status, 200);
  const r = put.json.region.pub;
  assert.deepEqual([r.province, r.city, r.source, r.note, r.by], ['上海', '上海', '人工录入', '电话核实', '乙']);
  const del = await call('DELETE', path, { body: {} });
  assert.equal(del.status, 200);
  assert.equal(del.json.region.pub, null);
  assert.equal(await total('pub=none'), 1);
});

test('参考城市：内容里写到的城市、品牌方所在地（设置里的对照表），和发布地分开筛选', async () => {
  const db = openStore(paths(dir));
  db.prepare("INSERT OR REPLACE INTO places (bvid, run_id, model, extracted_at, tokens, output, error) VALUES (?, 'r', 'm', '2026-09-24T03:20:00Z', 100, ?, NULL)").run(BV, JSON.stringify([
    { province: '浙江', city: '杭州', role: '门店/经营地', quote: '我们店在杭州', source: '简介', status: 'ok' },
    { province: '北京', city: '北京', role: '其他提及', quote: '北京的朋友', source: '口播', status: 'ok' },
  ]));
  db.close();
  const bad = await call('PUT', '/api/settings', { body: { brandPlaces: '只有品牌' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /对照表第 1 行/);
  // 对照表改了会把所有线索重新对一遍（顺带把上面的内容城市算进线索）
  const ok = await call('PUT', '/api/settings', { body: { brandPlaces: '某牌/某牌子 ｜ 某某生物科技有限公司 ｜ 江苏省 ｜ 苏州市 ｜ 企业信用信息公示系统' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.brandPlaces[0].city, '苏州');
  const list = await call('GET', '/api/leads?view=all');
  assert.deepEqual(list.json.rows[0].region, {
    content: [{ province: '浙江', city: '杭州', role: '门店/经营地' }],
    brand: [{ province: '江苏', city: '苏州', brand: '某牌', company: '某某生物科技有限公司' }],
  });
  const f = list.json.facets.place;
  assert.deepEqual([f.none, f.content.map((x) => x.value), f.brand.map((x) => x.value)], [0, ['content:C:浙江/杭州'], ['brand:C:江苏/苏州']]);
  const total = (qs) => call('GET', `/api/leads?view=all&${qs}`).then((x) => x.json.total);
  const place = (v) => total(`place=${encodeURIComponent(v)}`);
  assert.equal(await place('content:C:浙江/杭州'), 1);
  assert.equal(await place('content:P:浙江'), 1);
  assert.equal(await place('content:C:北京/北京'), 0); // 「其他提及」只展示、不参与筛选
  assert.equal(await place('brand:C:江苏/苏州'), 1);
  assert.equal(await place('brand:C:浙江/杭州'), 0);   // 两种来源分开
  assert.equal(await place('none'), 0);
  assert.equal(await total(`place=${encodeURIComponent('content:C:浙江/杭州')}&pub=none`), 1);
  assert.equal(await total(`place=${encodeURIComponent('content:C:浙江/杭州')}&pub=${encodeURIComponent('P:浙江')}`), 0); // 参考城市不会冒充发布地
  const d = await call('GET', `/api/leads/${BV}`);
  assert.equal(d.json.region.content.length, 2); // 详情里「其他提及」也列出来
  assert.equal(d.json.region.placesModel, 'm');
  const ov = await call('GET', '/api/overview');
  assert.deepEqual(ov.json.regions.content.map((x) => [x.label, x.n]), [['浙江·杭州', 1]]);
  assert.deepEqual(ov.json.regions.brand.map((x) => [x.label, x.n]), [['江苏·苏州', 1]]);
  assert.deepEqual([ov.json.regions.total, ov.json.regions.pubUnknown], [1, 1]);
  const csv = await call('GET', '/api/export/leads.csv');
  assert.ok(csv.text.includes('浙江·杭州（门店/经营地）'));
  assert.ok(csv.text.includes('江苏·苏州（某牌 · 某某生物科技有限公司）'));

  // 下拉框里的条数算上另一栏的筛选：选了哪一项就能看到几条
  assert.equal((await call('PUT', `/api/leads/${BV}/location`, { body: { province: '浙江', city: '杭州' } })).status, 200);
  const a = await call('GET', `/api/leads?view=all&place=${encodeURIComponent('brand:C:江苏/苏州')}`);
  assert.deepEqual(a.json.facets.pub.provinces.map((x) => [x.value, x.n]), [['P:浙江', 1]]);
  const b = await call('GET', '/api/leads?view=all&place=none');
  assert.deepEqual([b.json.total, b.json.facets.pub.provinces.length, b.json.facets.pub.none], [0, 0, 0]);
  const c = await call('GET', `/api/leads?view=all&pub=${encodeURIComponent('P:广东')}`);
  assert.deepEqual([c.json.total, c.json.facets.place.content.length, c.json.facets.place.brand.length], [0, 0, 0]);
  assert.equal((await call('DELETE', `/api/leads/${BV}/location`, { body: {} })).status, 200);
});

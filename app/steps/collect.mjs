// ④ 采集：本机 Edge（无头、全新配置、游客）慢速打开视频页，只取页面自己加载的东西：
// 简介全文、统计数、标题区文字、截图、音频（最低码率，按 Range 分段下载）。每条写一行存证清单（时间、网址、浏览器与脚本版本、每个文件的 SHA-256）。
// 不改 UA、不注入脚本、不伪造签名、不过验证码；连续 3 条拿不到页面数据就停手（抛 RiskError，后面碰 B站 的步骤都跳过）。
// 做法同研究版 scripts/collect.mjs；区别：排队按初筛优先级、每轮有上限、音频先写 .part 再改名（转写进程同时在读这个目录）。
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../../src/db.mjs';
import { RiskError } from '../../src/client.mjs';
import { downloadRanges, sleep } from '../lib/media.mjs';
import { tools } from '../store.mjs';

const SCRIPT_VERSION = 'app/steps/collect.mjs v1 (2026-09-24)';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export function collectQueue(db, limit = -1) {
  return db.prepare(`SELECT s.bvid FROM screening s JOIN comments c ON c.bvid = s.bvid JOIN videos v ON v.bvid = s.bvid
    LEFT JOIN media m ON m.bvid = s.bvid
    WHERE s.in_scope = 1 AND s.score IS NOT NULL AND (m.bvid IS NULL OR (m.audio_ok = 0 AND m.attempts < 3))
    ORDER BY s.priority DESC, v.play DESC, s.bvid LIMIT ?`).all(limit).map((r) => r.bvid);
}

export async function collect(ctx) {
  const { db, p, settings: cfg, runId, signal } = ctx;
  const todo = collectQueue(db, cfg.maxDeepPerRun);
  const queued = collectQueue(db).length;
  ctx.stats.collectQueued = queued;
  if (!todo.length) { ctx.log('没有待采集的视频'); return; }
  ctx.log(`待采集 ${queued} 条，这一轮采 ${todo.length} 条（每条约 25 秒，含礼貌间隔）`);
  const save = db.prepare(`INSERT INTO media (bvid, run_id, fetched_at, http, has_data, audio_ok, audio_bytes, audio_sha256, label_hits, error, attempts, files, browser, script)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET run_id = excluded.run_id, fetched_at = excluded.fetched_at, http = excluded.http, has_data = excluded.has_data,
      audio_ok = excluded.audio_ok, audio_bytes = excluded.audio_bytes, audio_sha256 = excluded.audio_sha256, label_hits = excluded.label_hits,
      error = excluded.error, attempts = MAX(media.attempts + 1, excluded.attempts), files = excluded.files, browser = excluded.browser, script = excluded.script`);
  const pwVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'playwright-core', 'package.json'), 'utf8')).version;
  const browser = await chromium.launch({ channel: tools().browserChannel, headless: true });
  let ok = 0, audioOk = 0, streak = 0, gone = 0;
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
    const browserVersion = `msedge ${browser.version()} headless`;
    for (const [n, bvid] of todo.entries()) {
      ctx.throwIfAborted();
      const dir = join(p.evidence, bvid);
      mkdirSync(dir, { recursive: true });
      const url = `https://www.bilibili.com/video/${bvid}/`;
      const page = await context.newPage();
      const playurl = [];
      page.on('response', async (res) => { if (/\/x\/player\/(wbi\/)?playurl/.test(res.url())) { try { playurl.push(await res.json()); } catch { /* 不是 JSON 就算了 */ } } });
      const rec = { bvid, url, runId, fetchedAt: new Date().toISOString(), browser: browserVersion, playwright: pwVersion, script: SCRIPT_VERSION, files: [] };
      const keep = (path, buf) => { writeFileSync(path, buf); rec.files.push({ path: relative(p.root, path).replace(/\\/g, '/'), bytes: buf.length, sha256: sha(buf) }); };
      let attemptsFloor = 0, hasData = false;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        rec.http = resp?.status();
        await page.waitForTimeout(5000);
        const info = await page.evaluate(() => {
          const v = window.__INITIAL_STATE__?.videoData;
          const box = document.querySelector('.video-info-container') ?? document.querySelector('#viewbox_report');
          return {
            pageTitle: document.title,
            ua: navigator.userAgent,
            dash: window.__playinfo__?.data?.dash ?? null,
            infoText: (box?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 600),
            video: v ? {
              aid: v.aid, cid: v.cid, title: v.title, desc: v.desc ?? '', tname: v.tname, pubdate: v.pubdate, duration: v.duration,
              owner: { mid: v.owner?.mid, name: v.owner?.name }, staff: (v.staff ?? []).map((s) => ({ mid: s.mid, name: s.name, title: s.title })),
              stat: v.stat, rights: v.rights, argue_info: v.argue_info ?? null,
            } : null,
            rawVideoData: v ? JSON.parse(JSON.stringify(v)) : null,
          };
        });
        rec.pageTitle = info.pageTitle;
        hasData = !!info.video;
        rec.labelHits = [...new Set(info.infoText.match(/广告|商业推广|推广|赞助|合作/g) ?? [])];
        keep(join(dir, 'page.png'), await page.screenshot());
        keep(join(dir, 'page.json'), Buffer.from(JSON.stringify({ url, fetchedAt: rec.fetchedAt, http: rec.http, pageTitle: info.pageTitle, infoText: info.infoText, video: info.video, rawVideoData: info.rawVideoData }, null, 1)));
        if (!info.video) {
          // 视频被删或设了权限：不算被拦，也不再重试；其他拿不到数据的情况算一次「被拦」
          if (rec.http === 404 || /视频去哪了|稿件不可见|已失效|出错啦/.test(info.pageTitle)) { gone++; attemptsFloor = 99; rec.reason = `视频不可访问：${info.pageTitle}`; }
          else { streak++; rec.reason = `没有页面数据：${info.pageTitle}`; }
        } else {
          ok++; streak = 0;
          const dash = info.dash ?? playurl.map((j) => j?.data?.dash).find(Boolean);
          if (dash?.audio?.length) {
            const a = [...dash.audio].sort((x, y) => x.bandwidth - y.bandwidth)[0];
            const { status, buf } = await downloadRanges(a.baseUrl ?? a.base_url, { Referer: url, 'User-Agent': info.ua }, { signal });
            rec.audioHttp = status;
            rec.audioOk = status === 200 && buf.length > 10000;
            if (rec.audioOk) {
              const part = join(p.audio, `${bvid}.m4a.part`);
              writeFileSync(part, buf);
              renameSync(part, join(p.audio, `${bvid}.m4a`));
              rec.files.push({ path: `audio/${bvid}.m4a`, bytes: buf.length, sha256: sha(buf) });
              audioOk++;
            }
          } else {
            rec.reason = '页面正常但没有音频流';
            attemptsFloor = 99;
          }
        }
      } catch (e) {
        if (signal.aborted) { await page.close().catch(() => {}); throw e; }
        rec.error = String(e.message ?? e).slice(0, 200);
        streak++;
      }
      await page.close().catch(() => {});
      appendFileSync(p.manifest, JSON.stringify(rec) + '\n');
      const audio = rec.files.find((f) => f.path.startsWith('audio/'));
      save.run(bvid, runId, rec.fetchedAt, rec.http ?? null, hasData ? 1 : 0, rec.audioOk ? 1 : 0,
        audio?.bytes ?? null, audio?.sha256 ?? null, JSON.stringify(rec.labelHits ?? []), rec.reason ?? rec.error ?? null, Math.max(1, attemptsFloor),
        JSON.stringify(rec.files), rec.browser, rec.script);
      ctx.progress(n + 1, todo.length, bvid);
      if (rec.reason || rec.error) ctx.log(`${bvid}：${rec.reason ?? rec.error}`, 'warn');
      if (streak >= 3) throw new RiskError(`连续 ${streak} 条拿不到页面数据，停手（B站 可能在限制访问）`);
      if (n < todo.length - 1) await sleep(10000 + Math.random() * 8000, signal);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  Object.assign(ctx.stats, { pagesOpened: todo.length, pagesOk: ok, collected: audioOk, gone, collectLeft: Math.max(0, queued - todo.length) });
  ctx.log(`打开 ${todo.length} 页，拿到页面数据 ${ok} 条、音频 ${audioOk} 条${gone ? `，${gone} 条视频已不可访问` : ''}`);
}

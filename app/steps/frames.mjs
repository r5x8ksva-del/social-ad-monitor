// ⑧ 取帧：对任一模型判为推广的视频，本机 Edge（无头、游客）打开视频页拿画面流（游客最高 480P，取 AVC），
// 读分片索引（sidx，B站 每片 5 秒），只下要看的分片：推广段前后各放 10 秒、整条推广的按间隔抽、开头 30 秒、结尾 15 秒，
// 每条最多 maxFramesPerVideo 帧。每片用 ffmpeg 取第一帧存 JPEG，不留视频本体。做法同研究版 scripts/m3-frames.mjs。
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { RiskError } from '../../src/client.mjs';
import { APP, tools } from '../store.mjs';
import { findCommand } from '../lib/env.mjs';
import { getRange, parseSidx, sleep } from '../lib/media.mjs';
import { wantedFragments } from '../lib/judge.mjs';

const SCRIPT_VERSION = 'app/steps/frames.mjs v1 (2026-09-24)';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const isPromo = (o) => !!o && (o.commercial === '确定' || o.commercial === '疑似');

export function framesQueue(db) {
  return db.prepare(`SELECT l.bvid, l.output, s.output AS second, v.duration_s FROM labels l JOIN videos v ON v.bvid = l.bvid
    LEFT JOIN second_labels s ON s.bvid = l.bvid LEFT JOIN frames f ON f.bvid = l.bvid
    WHERE l.output IS NOT NULL AND (f.bvid IS NULL OR (f.ok = 0 AND f.attempts < 3))`).all()
    .map((r) => ({ ...r, output: JSON.parse(r.output), second: r.second ? JSON.parse(r.second) : null }))
    .filter((r) => isPromo(r.output) || isPromo(r.second));
}

export async function frames(ctx) {
  const { db, p, settings: cfg, runId, signal } = ctx;
  const ffmpeg = findCommand(tools().ffmpeg);
  if (!ffmpeg) throw new Error(`找不到 ffmpeg：${tools().ffmpeg}（装好后放进 PATH，或在 config/app.json 的 ffmpeg 里写完整路径）`);
  const targets = framesQueue(db);
  if (!targets.length) { ctx.log('没有要取帧的视频'); return; }
  ctx.log(`取帧 ${targets.length} 条（每条最多 ${cfg.maxFramesPerVideo} 帧）`);
  const save = db.prepare(`INSERT INTO frames (bvid, run_id, fetched_at, ok, stream, frames, bytes, requests, error, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(bvid) DO UPDATE SET run_id = excluded.run_id, fetched_at = excluded.fetched_at, ok = excluded.ok, stream = excluded.stream,
      frames = excluded.frames, bytes = excluded.bytes, requests = excluded.requests, error = excluded.error, attempts = frames.attempts + 1`);
  const tmp = join(tmpdir(), `sam-frames-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const browser = await chromium.launch({ channel: tools().browserChannel, headless: true });
  let streak = 0, totalFrames = 0, totalBytes = 0;
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
    const browserVersion = `msedge ${browser.version()} headless`;
    for (const [n, row] of targets.entries()) {
      ctx.throwIfAborted();
      // 用判为推广的那个模型给的推广段和形式
      const lab = isPromo(row.output) ? row.output : row.second;
      const url = `https://www.bilibili.com/video/${row.bvid}/`;
      const rec = { bvid: row.bvid, url, runId, fetchedAt: new Date().toISOString(), browser: browserVersion, script: SCRIPT_VERSION, form: lab.form, ok: false, frames: [] };
      const page = await context.newPage();
      const playurl = [];
      page.on('response', async (res) => { if (/\/x\/player\/(wbi\/)?playurl/.test(res.url())) { try { playurl.push(await res.json()); } catch { /* 不是 JSON */ } } });
      let requests = 0;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(6000);
        const info = await page.evaluate(() => ({ ua: navigator.userAgent, dash: window.__playinfo__?.data?.dash ?? null, duration: window.__INITIAL_STATE__?.videoData?.duration ?? null }));
        const dash = info.dash ?? playurl.map((j) => j?.data?.dash).find(Boolean);
        if (!dash?.video?.length) throw new Error('页面没有画面流');
        streak = 0;
        const cands = dash.video.filter((v) => v.codecid === 7);
        const v = (cands.length ? cands : dash.video).sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth)[0];
        // 主地址中途断开时换备用地址（研究里一条 44 分钟视频的 akamai 镜像连续三次 terminated）
        const sources = [v.baseUrl ?? v.base_url, ...(v.backupUrl ?? v.backup_url ?? [])].filter(Boolean);
        let src = sources[0];
        const sb = v.segment_base ?? v.SegmentBase;
        const [i0, i1] = (sb.initialization ?? sb.Initialization).split('-').map(Number);
        const [x0, x1] = (sb.index_range ?? sb.indexRange).split('-').map(Number);
        const headers = { Referer: url, 'User-Agent': info.ua };
        const fetchRange = async (a, b) => {
          const order = [src, ...sources.filter((x) => x !== src)];
          for (const [i, cand] of order.entries()) {
            try { const buf = await getRange(cand, headers, a, b, signal); src = cand; requests++; return buf; }
            catch (e) { if (signal.aborted || i === order.length - 1) throw e; }
          }
        };
        const u = new URL(src);
        rec.stream = { id: v.id, codecid: v.codecid, codecs: v.codecs, width: v.width, height: v.height, bandwidth: v.bandwidth, host: u.host, path: u.pathname, backups: sources.length - 1 };
        const init = await fetchRange(i0, i1);
        const sidx = parseSidx(await fetchRange(x0, x1));
        let off = x1 + 1 + sidx.firstOffset;
        for (const r of sidx.refs) { r.offset = off; off += r.size; }
        const dur = info.duration ?? row.duration_s;
        const fragDur = sidx.refs[0]?.dur || 5;
        const want = wantedFragments({ segments: lab.segments ?? [], form: lab.form, dur, fragDur, count: sidx.refs.length, cap: cfg.maxFramesPerVideo });
        // 相邻分片合并成一次请求（每次最多约 6MB）
        const runs = [];
        for (const i of want) {
          const last = runs.at(-1);
          if (last && i === last.at(-1) + 1 && last.reduce((s, k) => s + sidx.refs[k].size, 0) < 6 * 1048576) last.push(i);
          else runs.push([i]);
        }
        const outDir = join(p.frames, row.bvid);
        mkdirSync(outDir, { recursive: true });
        let bytes = init.length;
        for (const run of runs) {
          ctx.throwIfAborted();
          const a = sidx.refs[run[0]].offset, b = sidx.refs[run.at(-1)].offset + sidx.refs[run.at(-1)].size - 1;
          const buf = await fetchRange(a, b);
          bytes += buf.length;
          for (const i of run) {
            const r = sidx.refs[i];
            const tmpMp4 = join(tmp, 'f.mp4');
            writeFileSync(tmpMp4, Buffer.concat([init, buf.subarray(r.offset - a, r.offset - a + r.size)]));
            const t = Math.round(r.start);
            const out = join(outDir, `t${String(t).padStart(5, '0')}.jpg`);
            try {
              execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', tmpMp4, '-frames:v', '1', '-q:v', '3', out], { stdio: 'pipe', timeout: 30000, windowsHide: true });
              const img = readFileSync(out);
              rec.frames.push({ t, file: relative(p.root, out).replace(/\\/g, '/'), bytes: img.length, sha256: sha(img) });
            } catch (e) {
              rec.frames.push({ t, error: String(e.stderr ?? e.message ?? e).slice(0, 160) });
            }
          }
          await sleep(300, signal);
        }
        rec.stream.usedHost = new URL(src).host;
        rec.fragments = { total: sidx.refs.length, fragDur, wanted: want.length, requests };
        rec.bytes = bytes;
        rec.ok = rec.frames.some((f) => f.sha256);
        totalFrames += rec.frames.filter((f) => f.sha256).length;
        totalBytes += bytes;
      } catch (e) {
        if (signal.aborted) { await page.close().catch(() => {}); throw e; }
        rec.error = String(e.message ?? e).slice(0, 200);
        streak++;
      }
      await page.close().catch(() => {});
      appendFileSync(p.framesManifest, JSON.stringify(rec) + '\n');
      const good = rec.frames.filter((f) => f.sha256);
      save.run(row.bvid, runId, rec.fetchedAt, rec.ok ? 1 : 0, JSON.stringify(rec.stream ?? null), JSON.stringify(good), rec.bytes ?? 0, requests, rec.error ?? null);
      ctx.progress(n + 1, targets.length, `${row.bvid} ${good.length} 帧`);
      if (rec.error) ctx.log(`${row.bvid} 取帧失败：${rec.error}`, 'warn');
      if (streak >= 3) throw new RiskError('连续 3 条拿不到画面流，停手（B站 可能在限制访问）');
      if (n < targets.length - 1) await sleep(10000 + Math.random() * 8000, signal);
    }
  } finally {
    await browser.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
  Object.assign(ctx.stats, { framesVideos: targets.length, frames: totalFrames, framesMB: Math.round(totalBytes / 1048576) });
  ctx.log(`取帧 ${targets.length} 条视频、${totalFrames} 帧，下载 ${Math.round(totalBytes / 1048576)} MB`);
}

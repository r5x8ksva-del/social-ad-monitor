// 网页自检：临时起一个不带定时器的网页服务（同一个工作区、另一个端口），用本机 Edge（无头）在桌面、手机、深色三种条件下
// 打开概览、线索（含证据抽屉）、运行记录、设置四页，查：脚本报错、横向溢出、该有的东西有没有；每页截图。
// 用法：node app/check.mjs（npm run check-app）；想查别的工作区就先设环境变量 SAM_WORKSPACE。退出码 0 为通过。
import './tz.mjs';
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/db.mjs';
import { paths, tools } from './store.mjs';

const p = paths();
const OUT = join(p.logs, 'app-check');
mkdirSync(OUT, { recursive: true });
const PORT = 18800 + Math.floor(Math.random() * 100);
const base = `http://127.0.0.1:${PORT}/`;
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'app', 'server.mjs')], {
  env: { ...process.env, SAM_PORT: String(PORT), SAM_NO_SCHEDULE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('网页服务没起来')), 20000);
  server.stdout.on('data', (c) => { if (String(c).includes('自动监测网页')) { clearTimeout(t); resolve(); } });
  server.on('exit', (code) => reject(new Error(`网页服务退出了（${code}）`)));
});

const browser = await chromium.launch({ channel: tools().browserChannel, headless: true });
const results = {};
let problems = 0;
try {
  for (const [name, viewport, colorScheme] of [['desktop', { width: 1280, height: 860 }, 'light'], ['mobile', { width: 375, height: 812 }, 'light'], ['dark', { width: 1280, height: 860 }, 'dark']]) {
    const ctx = await browser.newContext({ viewport, colorScheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
    page.on('requestfailed', (r) => { if (!/\.m4a$|\/api\/stream$/.test(r.url())) errors.push(`requestfailed ${r.url().slice(-60)} ${r.failure()?.errorText}`); });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const r = {};

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.run-panel', { timeout: 15000 });
    await page.waitForTimeout(1200);
    r.overview = await page.evaluate(() => ({ kpis: document.querySelectorAll('.kpi').length, steps: document.querySelectorAll('.steps-live li').length, env: document.querySelectorAll('.env li').length, logLines: document.querySelectorAll('.logbox > div').length, regionTables: document.querySelectorAll('.rts .rt').length }));
    r.overview.overflow = await overflow();
    await page.screenshot({ path: join(OUT, `${name}-overview.png`), fullPage: true });

    await page.goto(`${base}#/leads?view=all`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.seg button', { timeout: 15000 });
    await page.waitForTimeout(800);
    r.leads = await page.evaluate(() => ({ rows: document.querySelectorAll('tbody tr.click').length, seg: document.querySelectorAll('.seg button').length, cols: document.querySelectorAll('thead th').length,
      pubSel: document.querySelector('select[aria-label^="发布地"]')?.options.length ?? 0, placeSel: document.querySelector('select[aria-label^="参考城市"]')?.options.length ?? 0 }));
    // 打开「导入发布地」面板看看（手机上也不能撑出横向滚动）
    await page.evaluate(() => [...document.querySelectorAll('.page-head button')].find((b) => b.textContent.includes('导入发布地'))?.click());
    await page.waitForTimeout(200);
    r.leads.importPanel = await page.evaluate(() => { const x = document.querySelector('.imp'); return !!x && !x.hidden && !!x.querySelector('textarea'); });
    r.leads.overflow = await overflow();
    await page.screenshot({ path: join(OUT, `${name}-leads.png`) });
    if (r.leads.rows) {
      // 打开第一条推广线索（没有推广就打开第一条）
      await page.evaluate(() => { const rows = [...document.querySelectorAll('tbody tr.click')]; (rows.find((tr) => /推广·/.test(tr.textContent)) ?? rows[0]).click(); });
      await page.waitForSelector('#drawer.on .review', { timeout: 15000 });
      await page.waitForTimeout(1200);
      r.drawer = await page.evaluate(() => {
        const d = document.getElementById('drawer');
        return { sections: d.querySelectorAll('.d-sec').length, review: !!d.querySelector('.review .choices button'), lines: d.querySelectorAll('.tr-line').length, frames: d.querySelectorAll('.frame').length, audio: !!d.querySelector('audio'), timeline: !!d.querySelector('.tl-bar'), region: d.querySelectorAll('.region h4').length };
      });
      if (r.drawer.audio && r.drawer.lines > 3) {
        r.audio = await page.evaluate(async () => {
          const a = document.querySelector('#drawer audio');
          document.querySelectorAll('#drawer .tr-line button')[3]?.click();
          await new Promise((res) => setTimeout(res, 1500));
          return { t: Math.round(a.currentTime), err: a.error?.code ?? null };
        });
      }
      await page.screenshot({ path: join(OUT, `${name}-drawer.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    await page.goto(`${base}#/runs`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.page-head h1', { timeout: 15000 });
    await page.waitForTimeout(600);
    r.runs = await page.evaluate(() => ({ rows: document.querySelectorAll('tbody tr.click').length }));
    if (r.runs.rows) {
      await page.click('tbody tr.click');
      await page.waitForSelector('.steps-live', { timeout: 15000 });
      await page.waitForTimeout(500);
      r.runDetail = await page.evaluate(() => ({ steps: document.querySelectorAll('.steps-live li').length, log: document.querySelectorAll('.logbox > div').length }));
      r.runDetail.overflow = await overflow();
    }
    await page.screenshot({ path: join(OUT, `${name}-runs.png`) });

    await page.goto(`${base}#/settings`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('form.form', { timeout: 15000 });
    await page.waitForTimeout(500);
    r.settings = await page.evaluate(() => ({ fieldsets: document.querySelectorAll('form.form fieldset').length, keywords: document.querySelector('textarea[name="keywords"]')?.value.split('\n').length ?? 0,
      placeDetect: !!document.querySelector('input[name="placeDetect"]'), brandPlaces: !!document.querySelector('textarea[name="brandPlaces"]') }));
    r.settings.overflow = await overflow();
    await page.screenshot({ path: join(OUT, `${name}-settings.png`), fullPage: true });

    r.errors = [...new Set(errors)];
    const bad = [r.overview.overflow, r.leads.overflow, r.runDetail?.overflow ?? 0, r.settings.overflow].some((x) => x > 0)
      || r.overview.kpis !== 6 || r.overview.regionTables !== 3 || r.settings.fieldsets !== 6 || !r.settings.placeDetect || !r.settings.brandPlaces || r.errors.length
      || r.leads.cols !== 11 || r.leads.pubSel < 2 || r.leads.placeSel < 2 || !r.leads.importPanel
      || (r.drawer && (!r.drawer.review || r.drawer.sections < 3 || r.drawer.region !== 3)) || (r.audio && (r.audio.err || r.audio.t < 1))
      || (r.runs.rows && !r.runDetail?.steps);
    if (bad) problems++;
    results[name] = { ok: !bad, ...r };
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(JSON.stringify(results, null, 1));
console.log(problems ? `有 ${problems} 种条件没通过` : `三种条件都通过；截图在 ${OUT}`);
process.exitCode = problems ? 1 : 0;

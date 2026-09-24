// 设置校验、运行锁、定时计算
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateSettings, defaultSettings, paths, ensureDirs, acquireLock, releaseLock, readLock, loadSettings, saveSettings } from '../app/store.mjs';
import { lastSlot, nextSlot, dueSlot } from '../app/lib/schedule.mjs';

test('默认设置来自 config/health.json，并且本身能通过校验', () => {
  const d = defaultSettings();
  assert.ok(d.keywords.length > 0 && d.relevanceTerms.length > 0);
  assert.deepEqual(validateSettings(d, d).errors, []);
});

test('设置校验：列表拆分去重、数字范围、品类词不能为空、定时格式', () => {
  const base = defaultSettings();
  const ok = validateSettings({ keywords: '鱼油，益生菌\n鱼油\n', maxDeepPerRun: '80', schedule: { enabled: true, time: '07:30', frequency: 'weekly', weekday: 3 } }, base);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.settings.keywords, ['鱼油', '益生菌']);
  assert.equal(ok.settings.maxDeepPerRun, 80);
  assert.deepEqual(ok.settings.schedule, { enabled: true, frequency: 'weekly', time: '07:30', weekday: 3 });
  const bad = validateSettings({ relevanceTerms: [], maxDeepPerRun: 0, schedule: { time: '25:00' }, firstRunDays: 20 }, base);
  assert.equal(bad.errors.length, 4);
  assert.deepEqual(bad.settings.relevanceTerms, base.relevanceTerms);  // 不合格的字段保留原值
  assert.equal(validateSettings({ firstRunDays: 10, maxLookbackDays: 5 }, base).errors.length, 1);
  assert.equal(validateSettings([], base).errors.length, 1);
});

test('设置读写：坏字段回落到默认值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-test-'));
  try {
    const p = paths(dir);
    ensureDirs(p);
    const s = { ...defaultSettings(), maxDeepPerRun: 12 };
    saveSettings(p, s);
    assert.equal(loadSettings(p).maxDeepPerRun, 12);
    writeFileSync(p.settings, JSON.stringify({ maxDeepPerRun: -5, reviewer: '张三' }));
    const l = loadSettings(p);
    assert.equal(l.maxDeepPerRun, defaultSettings().maxDeepPerRun);
    assert.equal(l.reviewer, '张三');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('运行锁：同一进程可重入，别的活进程占着就拿不到，死进程的锁自动失效', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sam-test-'));
  try {
    const p = paths(dir);
    ensureDirs(p);
    assert.equal(acquireLock(p, 'run-a').ok, true);
    assert.equal(readLock(p).runId, 'run-a');
    releaseLock(p);
    assert.equal(readLock(p), null);
    // 父进程（运行测试的 node）一定活着
    writeFileSync(p.lock, JSON.stringify({ pid: process.ppid, runId: 'run-other', at: new Date().toISOString() }));
    const busy = acquireLock(p, 'run-b');
    assert.equal(busy.ok, false);
    assert.equal(busy.holder.runId, 'run-other');
    writeFileSync(p.lock, JSON.stringify({ pid: 999999, runId: 'run-dead', at: new Date().toISOString() }));
    assert.equal(acquireLock(p, 'run-c').ok, true);
    writeFileSync(p.lock, JSON.stringify({ pid: process.ppid, runId: 'run-old', at: '2020-01-01T00:00:00Z' }));
    assert.equal(acquireLock(p, 'run-d').ok, true);  // 超过 36 小时的锁当作失效
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('定时：每天、每周的最近一次和下一次（本机时区）', () => {
  const now = new Date(2026, 8, 24, 10, 0);                  // 周四 10:00
  const daily = { enabled: true, frequency: 'daily', time: '03:00', weekday: 1 };
  assert.deepEqual(lastSlot(now, daily), new Date(2026, 8, 24, 3, 0));
  assert.deepEqual(nextSlot(now, daily), new Date(2026, 8, 25, 3, 0));
  assert.deepEqual(lastSlot(now, { ...daily, time: '22:00' }), new Date(2026, 8, 23, 22, 0));
  const weekly = { enabled: true, frequency: 'weekly', time: '09:00', weekday: 1 }; // 周一
  assert.deepEqual(lastSlot(now, weekly), new Date(2026, 8, 21, 9, 0));
  assert.deepEqual(nextSlot(now, weekly), new Date(2026, 8, 28, 9, 0));
  assert.deepEqual(lastSlot(new Date(2026, 8, 21, 8, 0), weekly), new Date(2026, 8, 14, 9, 0));
});

test('定时：到点跑一次；跑过（或刚打开定时时记下的时刻）就不重复；关掉不跑', () => {
  const sch = { enabled: true, frequency: 'daily', time: '03:00', weekday: 1 };
  const now = new Date(2026, 8, 24, 10, 0);
  assert.deepEqual(dueSlot(now, sch, null), new Date(2026, 8, 24, 3, 0));
  assert.deepEqual(dueSlot(now, sch, new Date(2026, 8, 23, 3, 0).toISOString()), new Date(2026, 8, 24, 3, 0)); // 昨天跑过，今天的还没跑
  assert.equal(dueSlot(now, sch, new Date(2026, 8, 24, 3, 0).toISOString()), null);
  assert.equal(dueSlot(now, { ...sch, enabled: false }, null), null);
});

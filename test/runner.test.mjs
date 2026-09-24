// 增量：这一轮从哪个发布时间开始搜（computeSince），划范围的发布时间下限（scopeCutoff）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths, openStore, setMeta, defaultSettings } from '../app/store.mjs';
import { computeSince, scopeCutoff } from '../app/runner.mjs';

const DAY = 86400;
const now = 1_790_000_000;
const settings = { ...defaultSettings(), firstRunDays: 3, maxLookbackDays: 14 };

function withDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-runner-'));
  try { const db = openStore(paths(dir)); fn(db); db.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('第一轮：回溯 firstRunDays 天；划范围下限就是这个起点', () => withDb((db) => {
  const since = computeSince(db, settings, now);
  assert.equal(since, now - 3 * DAY);
  assert.equal(scopeCutoff(db, settings, now, since), since);
}));

test('之后：从上一轮「发现」跑完的时刻往前多看 1 天，最多回溯 14 天', () => withDb((db) => {
  setMeta(db, 'discoveredThrough', now - 2 * 3600);
  assert.equal(computeSince(db, settings, now), now - 2 * 3600 - DAY);
  setMeta(db, 'discoveredThrough', now - 30 * DAY);   // 隔了一个月没跑
  assert.equal(computeSince(db, settings, now), now - 14 * DAY);
}));

test('划范围：监测开始以后发布的都算（收录晚也不漏），但不超过 14 天', () => withDb((db) => {
  const since = now - 2 * 3600 - DAY;
  setMeta(db, 'monitorStart', now - 5 * DAY);
  assert.equal(scopeCutoff(db, settings, now, since), now - 5 * DAY);
  setMeta(db, 'monitorStart', now - 60 * DAY);
  assert.equal(scopeCutoff(db, settings, now, since), now - 14 * DAY);
}));

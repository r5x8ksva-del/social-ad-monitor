// 划范围：品类词留空时用搜索关键词代替（空的品类词不能变成「搜到的全都算」）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { paths, openStore, defaultSettings } from '../app/store.mjs';
import { scopeStep } from '../app/steps/scope.mjs';

async function runScope(settings) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-scope-'));
  try {
    const db = openStore(paths(dir));
    const now = 1_790_000_000;
    const put = db.prepare('INSERT INTO videos (bvid, title, description, tags, typename, duration_s, pubdate) VALUES (?, ?, ?, ?, ?, ?, ?)');
    put.run('BV1fish', '每天一颗鱼油，我坚持了三个月', '', '', '日常', 300, now);
    put.run('BV1vitc', '维C 到底要不要补', '', '', '日常', 300, now);
    put.run('BV1hike', '周末去爬山', '', '', '日常', 300, now);
    await scopeStep({ db, settings, since: now - 86400, runId: 'run-t', stats: {}, progress: () => {}, log: () => {} });
    const got = Object.fromEntries(db.prepare('SELECT bvid, scope_note FROM screening').all().map((r) => [r.bvid, r.scope_note]));
    db.close();
    return got;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('品类词留空：拿搜索关键词判断，标题里没有关键词的照样排除', async () => {
  const got = await runScope({ ...defaultSettings(), keywords: ['鱼油'], relevanceTerms: [] });
  assert.deepEqual(got, { BV1fish: 'in:title', BV1vitc: 'out:不含品类词', BV1hike: 'out:不含品类词' });
});

test('品类词填了：只按品类词判断（和以前一样）', async () => {
  const got = await runScope({ ...defaultSettings(), keywords: ['鱼油'], relevanceTerms: ['维C'] });
  assert.deepEqual(got, { BV1fish: 'out:不含品类词', BV1vitc: 'in:title', BV1hike: 'out:不含品类词' });
});

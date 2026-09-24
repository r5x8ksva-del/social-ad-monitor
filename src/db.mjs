// 本地 SQLite（Node 自带的 node:sqlite）。只存公开内容；评论只存文字和点赞数，不存评论者身份。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..');
export const DATA = join(ROOT, 'data');

export function openDb(path = join(DATA, 'monitor.sqlite')) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS videos (
      bvid TEXT PRIMARY KEY,
      aid INTEGER, mid INTEGER, author TEXT,
      title TEXT, description TEXT, tags TEXT, typename TEXT,
      duration_s INTEGER, pubdate INTEGER,
      play INTEGER, danmaku INTEGER, replies INTEGER, favorites INTEGER, likes INTEGER,
      is_union INTEGER,
      first_seen TEXT, last_seen TEXT,
      raw TEXT
    );
    CREATE TABLE IF NOT EXISTS hits (
      bvid TEXT, keyword TEXT, page INTEGER, rank INTEGER, run_id TEXT, fetched_at TEXT,
      PRIMARY KEY (bvid, keyword)
    );
    CREATE TABLE IF NOT EXISTS comments (
      bvid TEXT PRIMARY KEY, fetched_at TEXT, code INTEGER,
      top_text TEXT, top_by_up INTEGER, top_links TEXT, top_like INTEGER,
      hot TEXT, total INTEGER
    );
    CREATE TABLE IF NOT EXISTS screening (
      bvid TEXT PRIMARY KEY, run_id TEXT,
      in_scope INTEGER, scope_note TEXT,
      score REAL, priority REAL, features TEXT, reasons TEXT,
      selected INTEGER, audit INTEGER
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY, step TEXT, started_at TEXT, finished_at TEXT, params TEXT, stats TEXT
    );
  `);
  return db;
}

export function newRunId(step) {
  return `${step}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
}

-- 瀏覽計數器資料表（Cloudflare D1 / SQLite）
--
-- 套用方式：
--   wrangler d1 execute ltc-blog-views --remote --file=./cloudflare/schema.sql

CREATE TABLE IF NOT EXISTS page_views (
  slug       TEXT    PRIMARY KEY,
  views      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Sentinel 事件持久化表
-- 存储全链路哨兵监控系统的事件、状态、历史记录

CREATE TABLE IF NOT EXISTS sentinel_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  dedupe_key    TEXT NOT NULL,
  title         TEXT NOT NULL,
  service       TEXT NOT NULL DEFAULT '',
  module        TEXT NOT NULL DEFAULT '',
  severity      TEXT NOT NULL CHECK (severity IN ('p1', 'p2', 'p3')),
  status        TEXT NOT NULL DEFAULT 'detected',
  validation    TEXT NOT NULL DEFAULT '{"status":"pending"}',
  context       TEXT NOT NULL DEFAULT '{}',
  history       TEXT NOT NULL DEFAULT '[]',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sentinel_events_project_id ON sentinel_events(project_id);
CREATE INDEX IF NOT EXISTS idx_sentinel_events_status ON sentinel_events(status);
CREATE INDEX IF NOT EXISTS idx_sentinel_events_severity ON sentinel_events(severity);
CREATE INDEX IF NOT EXISTS idx_sentinel_events_dedupe_key ON sentinel_events(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_sentinel_events_timestamp ON sentinel_events(timestamp);

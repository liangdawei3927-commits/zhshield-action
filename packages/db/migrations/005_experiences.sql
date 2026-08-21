CREATE TABLE IF NOT EXISTS experiences (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('true-positive', 'false-positive', 'suggestion', 'custom')),
  detail TEXT,
  source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_experiences_lookup ON experiences(project_id, rule_id, created_at);

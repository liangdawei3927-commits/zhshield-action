CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'disabled', 'deprecated', 'experimental')),
  severity TEXT,
  weight REAL DEFAULT 1.0,
  reason TEXT,
  changed_by TEXT,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

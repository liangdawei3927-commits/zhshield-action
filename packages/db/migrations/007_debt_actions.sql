CREATE TABLE IF NOT EXISTS debt_actions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  action_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'planned', 'in-progress', 'repaid', 'dismissed')),
  module TEXT NOT NULL,
  category TEXT NOT NULL,
  issue_ids TEXT NOT NULL,
  interest_score REAL NOT NULL,
  principal_estimate REAL NOT NULL,
  roi REAL NOT NULL,
  sprint TEXT,
  gate TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, action_id)
);
CREATE INDEX IF NOT EXISTS idx_debt_actions_project ON debt_actions(project_id);

CREATE TABLE IF NOT EXISTS debt_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  debt_index REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_debt_snapshots_project ON debt_snapshots(project_id, created_at);

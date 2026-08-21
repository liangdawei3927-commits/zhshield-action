CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  overall REAL NOT NULL,
  grade TEXT NOT NULL CHECK(grade IN ('A', 'B', 'C', 'D')),
  dimensions TEXT NOT NULL,
  trend TEXT NOT NULL CHECK(trend IN ('improving', 'stable', 'declining')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scores_project ON scores(project_id, created_at);

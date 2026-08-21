CREATE TABLE IF NOT EXISTS scanning_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  source TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  report TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_scanning_results_project ON scanning_results(project_id, source, created_at);

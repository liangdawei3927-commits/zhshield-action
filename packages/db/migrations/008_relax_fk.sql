-- 008_relax_fk.sql
--
-- 背景：desktop 端从不向 projects 表写行（app:saveProjects 只写 projects.json），
-- 而本库强制 PRAGMA foreign_keys = ON，导致评分/扫描/债务落库时
--    FOREIGN KEY constraint failed (19)
-- 每次 INSERT 都被拒（scores、scanning_results、debt_actions、debt_snapshots），
-- 体检分数永远写不进去，UI 显示"尚未体检"。
--
-- 修复：SQLite 不支持 DROP CONSTRAINT，按"建新表 → 拷贝 → DROP → RENAME"重建
-- 四张表，仅移除对 projects(id) 的外键引用，其余 schema 不变。
-- 该迁移由 DbConnection.migrate 在事务内执行。

-- ─── scores：去掉 REFERENCES projects(id) ───────────────────────────────
CREATE TABLE scores_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  overall REAL NOT NULL,
  grade TEXT NOT NULL CHECK(grade IN ('A', 'B', 'C', 'D')),
  dimensions TEXT NOT NULL,
  trend TEXT NOT NULL CHECK(trend IN ('improving', 'stable', 'declining')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO scores_new (id, project_id, overall, grade, dimensions, trend, created_at)
  SELECT id, project_id, overall, grade, dimensions, trend, created_at FROM scores;

DROP TABLE scores;
ALTER TABLE scores_new RENAME TO scores;
CREATE INDEX IF NOT EXISTS idx_scores_project ON scores(project_id, created_at);

-- ─── scanning_results：去掉 REFERENCES projects(id) ─────────────────────
CREATE TABLE scanning_results_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  source TEXT NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  report TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO scanning_results_new (id, project_id, source, passed, summary, report, created_at)
  SELECT id, project_id, source, passed, summary, report, created_at FROM scanning_results;

DROP TABLE scanning_results;
ALTER TABLE scanning_results_new RENAME TO scanning_results;
CREATE INDEX IF NOT EXISTS idx_scanning_results_project ON scanning_results(project_id, source, created_at);

-- ─── debt_actions：去掉 REFERENCES projects(id) ─────────────────────────
CREATE TABLE debt_actions_new (
  project_id TEXT NOT NULL,
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

INSERT INTO debt_actions_new (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, sprint, gate, created_at, updated_at)
  SELECT project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, sprint, gate, created_at, updated_at FROM debt_actions;

DROP TABLE debt_actions;
ALTER TABLE debt_actions_new RENAME TO debt_actions;
CREATE INDEX IF NOT EXISTS idx_debt_actions_project ON debt_actions(project_id);

-- ─── debt_snapshots：去掉 REFERENCES projects(id) ───────────────────────
CREATE TABLE debt_snapshots_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  debt_index REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO debt_snapshots_new (id, project_id, debt_index, created_at)
  SELECT id, project_id, debt_index, created_at FROM debt_snapshots;

DROP TABLE debt_snapshots;
ALTER TABLE debt_snapshots_new RENAME TO debt_snapshots;
CREATE INDEX IF NOT EXISTS idx_debt_snapshots_project ON debt_snapshots(project_id, created_at);
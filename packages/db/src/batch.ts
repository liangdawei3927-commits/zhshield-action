import type Database from 'better-sqlite3';
import type {
  CreateProjectParams,
  SaveScoreParams,
  SaveScanResultParams,
  SaveExperienceParams,
  CreateSentinelEventParams,
  SaveDebtActionParams,
  SaveDebtSnapshotParams,
} from './types';

// ─── 批量写入（单事务 + prepared insert，all-or-nothing）─────────────────
// 每个函数在单个 better-sqlite3 事务内循环执行 prepared insert，
// 任一行失败则整体回滚，不落任何行。

export function createProjectsBatch(db: Database.Database, projects: CreateProjectParams[]): void {
  const insert = db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)');
  db.transaction((rows: CreateProjectParams[]) => {
    for (const p of rows) insert.run(p.id, p.name, p.path);
  })(projects);
}

export function saveScoresBatch(db: Database.Database, scores: SaveScoreParams[]): void {
  const insert = db.prepare(
    'INSERT INTO scores (project_id, overall, grade, dimensions, trend) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction((rows: SaveScoreParams[]) => {
    for (const s of rows) insert.run(s.projectId, s.overall, s.grade, s.dimensions, s.trend);
  })(scores);
}

export function saveScanResultsBatch(
  db: Database.Database,
  scanResults: SaveScanResultParams[],
): void {
  const insert = db.prepare(
    'INSERT INTO scanning_results (project_id, source, passed, summary, report) VALUES (?, ?, ?, ?, ?)',
  );
  db.transaction((rows: SaveScanResultParams[]) => {
    for (const r of rows)
      insert.run(r.projectId, r.source, r.passed ? 1 : 0, r.summary, r.report ?? null);
  })(scanResults);
}

export function saveExperiencesBatch(
  db: Database.Database,
  experiences: SaveExperienceParams[],
): void {
  const insert = db.prepare(
    'INSERT INTO experiences (id, project_id, rule_id, type, detail, source) VALUES (?, ?, ?, ?, ?, ?)',
  );
  db.transaction((rows: SaveExperienceParams[]) => {
    for (const e of rows)
      insert.run(e.id, e.projectId, e.ruleId, e.type, e.detail ?? null, e.source ?? null);
  })(experiences);
}

export function createSentinelEventsBatch(
  db: Database.Database,
  events: CreateSentinelEventParams[],
): void {
  const insert = db.prepare(`
    INSERT INTO sentinel_events (id, project_id, timestamp, dedupe_key, title, service, module, severity, status, validation, context, history, occurrence_count, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction((rows: CreateSentinelEventParams[]) => {
    for (const e of rows) {
      insert.run(
        e.id,
        e.projectId,
        e.timestamp.toISOString(),
        e.dedupeKey,
        e.title,
        e.service,
        e.module,
        e.severity,
        e.status,
        e.validation,
        e.context,
        e.history,
        e.occurrenceCount,
        e.firstSeen.toISOString(),
        e.lastSeen.toISOString(),
      );
    }
  })(events);
}

export function saveDebtActionsBatch(db: Database.Database, actions: SaveDebtActionParams[]): void {
  const insert = db.prepare(
    `INSERT INTO debt_actions (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, sprint, gate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, action_id) DO UPDATE SET
       status = excluded.status,
       module = excluded.module,
       category = excluded.category,
       issue_ids = excluded.issue_ids,
       interest_score = excluded.interest_score,
       principal_estimate = excluded.principal_estimate,
       roi = excluded.roi,
       sprint = excluded.sprint,
       gate = excluded.gate,
       updated_at = CURRENT_TIMESTAMP`,
  );
  db.transaction((rows: SaveDebtActionParams[]) => {
    for (const a of rows) {
      insert.run(
        a.projectId,
        a.actionId,
        a.status,
        a.module,
        a.category,
        JSON.stringify(a.issueIds),
        a.interestScore,
        a.principalEstimate,
        a.roi,
        a.sprint ?? null,
        a.gate ?? null,
      );
    }
  })(actions);
}

export function saveDebtSnapshotsBatch(
  db: Database.Database,
  snapshots: SaveDebtSnapshotParams[],
): void {
  const insert = db.prepare('INSERT INTO debt_snapshots (project_id, debt_index) VALUES (?, ?)');
  db.transaction((rows: SaveDebtSnapshotParams[]) => {
    for (const s of rows) insert.run(s.projectId, s.debtIndex);
  })(snapshots);
}

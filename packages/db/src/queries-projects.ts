import type Database from 'better-sqlite3';
import { DEBT_ACTION_UPSERT_SQL } from './sql';
import type {
  ProjectRow,
  ScoreRow,
  ScanningResultRow,
  CreateProjectParams,
  SaveScoreParams,
  SaveScanResultParams,
  SaveDebtActionParams,
  UpdateDebtActionStatusParams,
  DebtActionRow,
  SaveDebtSnapshotParams,
  DebtSnapshotRow,
} from './types';

// ─── Projects ─────────────────────────────────────────────

export function createProject(db: Database.Database, params: CreateProjectParams): void {
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(
    params.id,
    params.name,
    params.path,
  );
}

export function getProject(db: Database.Database, id: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
}

export function getProjectByPath(db: Database.Database, path: string): ProjectRow | undefined {
  return db.prepare('SELECT * FROM projects WHERE path = ?').get(path) as ProjectRow | undefined;
}

export function listProjects(db: Database.Database): ProjectRow[] {
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[];
}

export function deleteProject(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// ─── Scores ───────────────────────────────────────────────

export function saveScore(db: Database.Database, params: SaveScoreParams): void {
  db.prepare(
    'INSERT INTO scores (project_id, overall, grade, dimensions, trend) VALUES (?, ?, ?, ?, ?)',
  ).run(params.projectId, params.overall, params.grade, params.dimensions, params.trend);
}

export function getLatestScore(db: Database.Database, projectId: string): ScoreRow | undefined {
  return db
    .prepare('SELECT * FROM scores WHERE project_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(projectId) as ScoreRow | undefined;
}

export function getScoreHistory(db: Database.Database, projectId: string, limit = 30): ScoreRow[] {
  return db
    .prepare('SELECT * FROM scores WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit) as ScoreRow[];
}

export function getScoreTrend(db: Database.Database, projectId: string): ScoreRow[] {
  return db
    .prepare('SELECT * FROM scores WHERE project_id = ? ORDER BY created_at ASC')
    .all(projectId) as ScoreRow[];
}

// ─── Scanning Results ─────────────────────────────────────

export function saveScanResult(db: Database.Database, params: SaveScanResultParams): void {
  db.prepare(
    'INSERT INTO scanning_results (project_id, source, passed, summary, report) VALUES (?, ?, ?, ?, ?)',
  ).run(
    params.projectId,
    params.source,
    params.passed ? 1 : 0,
    params.summary,
    params.report ?? null,
  );
}

export function getLatestScanResult(
  db: Database.Database,
  projectId: string,
  source: string,
): ScanningResultRow | undefined {
  return db
    .prepare(
      'SELECT * FROM scanning_results WHERE project_id = ? AND source = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(projectId, source) as ScanningResultRow | undefined;
}

export function listScanResults(
  db: Database.Database,
  projectId: string,
  source?: string,
): ScanningResultRow[] {
  if (source) {
    return db
      .prepare(
        'SELECT * FROM scanning_results WHERE project_id = ? AND source = ? ORDER BY created_at DESC',
      )
      .all(projectId, source) as ScanningResultRow[];
  }
  return db
    .prepare('SELECT * FROM scanning_results WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as ScanningResultRow[];
}

// ─── Tech Debt Actions & Snapshots ────────────────────────

export function saveDebtAction(db: Database.Database, params: SaveDebtActionParams): void {
  db.prepare(DEBT_ACTION_UPSERT_SQL).run(
    params.projectId,
    params.actionId,
    params.status,
    params.module,
    params.category,
    JSON.stringify(params.issueIds),
    params.interestScore,
    params.principalEstimate,
    params.roi,
    params.sprint ?? null,
    params.gate ?? null,
  );
}

export function updateDebtActionStatus(
  db: Database.Database,
  params: UpdateDebtActionStatusParams,
): void {
  db.prepare(
    'UPDATE debt_actions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE project_id = ? AND action_id = ?',
  ).run(params.status, params.projectId, params.actionId);
}

export function getDebtActionsByProject(db: Database.Database, projectId: string): DebtActionRow[] {
  return db
    .prepare('SELECT * FROM debt_actions WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId) as DebtActionRow[];
}

export function saveDebtSnapshot(db: Database.Database, params: SaveDebtSnapshotParams): void {
  db.prepare('INSERT INTO debt_snapshots (project_id, debt_index) VALUES (?, ?)').run(
    params.projectId,
    params.debtIndex,
  );
}

export function getLatestDebtSnapshot(
  db: Database.Database,
  projectId: string,
): DebtSnapshotRow | undefined {
  return db
    .prepare('SELECT * FROM debt_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(projectId) as DebtSnapshotRow | undefined;
}

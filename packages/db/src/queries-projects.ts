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

/**
 * 最新一条评分（**排除软删记录**）。
 *
 * `deleted_at IS NOT NULL` 的行只在地理位置（project 被移除后的 TTL 窗口）里存活，
 * 语义上已不属于该项目的当前状态；读取路径不过滤 = 已删除项目的旧分仍然能当「当前分」返回。
 *
 * `id` 作为第二排序键：`created_at` 只有秒级精度，同一秒内多次落分（一次 pipeline
 * 里汇总 + 单域写分会同秒）会出现并列，只按时间排会让「哪条算最新」变成不确定行为。
 */
export function getLatestScore(db: Database.Database, projectId: string): ScoreRow | undefined {
  return db
    .prepare(
      'SELECT * FROM scores WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1',
    )
    .get(projectId) as ScoreRow | undefined;
}

/**
 * 评分历史：取**最新的 N 条**，但按**时间升序**返回。
 *
 * ⚠️ 这里曾经是 `ORDER BY created_at DESC LIMIT ?`，直接返回倒序 —— 而所有消费方都
 * 按「旧 → 新」使用这个数组：
 * - 渲染层 `ReportsPage` 取 `data.at(-1)` 当「最新总分」；
 * - `HistoryTable` 用 `data.toReversed()` 把表翻成最新在上；
 * - `ScoringEngine.getTrendReport` 取 `history.slice(-windowSize)` 当近期窗口；
 * - 单测（`scoring.service.test.ts`、`engine.test.ts`）断言 `history[0]` 是最旧一条。
 *
 * 倒序返回的后果不是「顺序不同」而是**内容取反**：报告中心显示的「最新总分」实际是
 * 项目历史上第一条记录，卡片数量也随那条老记录的维度集变化（详见回归用例
 * `score-history-order.test.ts`）。
 *
 * 正确形态：内层按 `created_at DESC, id DESC` 取最新 N 条，外层再升序吐出，
 * 既保住「取最新」的截断语义，又满足升序契约。
 */
export function getScoreHistory(db: Database.Database, projectId: string, limit = 30): ScoreRow[] {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM scores
         WHERE project_id = ? AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`,
    )
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

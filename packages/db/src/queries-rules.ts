import type Database from 'better-sqlite3';
import type {
  RuleRow,
  ExperienceRow,
  UpsertRuleParams,
  SaveExperienceParams,
} from './types';

// ─── Rules ────────────────────────────────────────────────

export function upsertRule(db: Database.Database, params: UpsertRuleParams): void {
  db.prepare(
    `
    INSERT INTO rules (id, rule_id, state, severity, weight, reason, changed_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(rule_id) DO UPDATE SET
      state      = COALESCE(?, state),
      severity   = COALESCE(?, severity),
      weight     = COALESCE(?, weight),
      reason     = COALESCE(?, reason),
      changed_by = COALESCE(?, changed_by),
      changed_at = CURRENT_TIMESTAMP
  `,
  ).run(
    params.ruleId,
    params.ruleId,
    params.state ?? 'active',
    params.severity ?? null,
    params.weight ?? 1.0,
    params.reason ?? null,
    params.changedBy ?? null,
    // COALESCE args
    params.state ?? null,
    params.severity ?? null,
    params.weight ?? null,
    params.reason ?? null,
    params.changedBy ?? null,
  );
}

export function getRule(db: Database.Database, ruleId: string): RuleRow | undefined {
  return db.prepare('SELECT * FROM rules WHERE rule_id = ?').get(ruleId) as RuleRow | undefined;
}

export function listRules(db: Database.Database): RuleRow[] {
  return db.prepare('SELECT * FROM rules ORDER BY changed_at DESC').all() as RuleRow[];
}

// ─── Experiences ──────────────────────────────────────────

export function saveExperience(db: Database.Database, params: SaveExperienceParams): void {
  db.prepare(
    'INSERT INTO experiences (id, project_id, rule_id, type, detail, source) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    params.id,
    params.projectId,
    params.ruleId,
    params.type,
    params.detail ?? null,
    params.source ?? null,
  );
}

export function listExperiences(
  db: Database.Database,
  projectId?: string,
  ruleId?: string,
): ExperienceRow[] {
  let sql = 'SELECT * FROM experiences WHERE 1=1';
  const params: unknown[] = [];
  if (projectId) {
    sql += ' AND project_id = ?';
    params.push(projectId);
  }
  if (ruleId) {
    sql += ' AND rule_id = ?';
    params.push(ruleId);
  }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params) as ExperienceRow[];
}

export function getExperienceStats(
  db: Database.Database,
  ruleId: string,
): { total: number; truePositives: number; falsePositives: number } {
  const total = (
    db.prepare('SELECT COUNT(*) as c FROM experiences WHERE rule_id = ?').get(ruleId) as {
      c: number;
    }
  ).c;
  const truePositives = (
    db
      .prepare("SELECT COUNT(*) as c FROM experiences WHERE rule_id = ? AND type = 'true-positive'")
      .get(ruleId) as { c: number }
  ).c;
  const falsePositives = (
    db
      .prepare(
        "SELECT COUNT(*) as c FROM experiences WHERE rule_id = ? AND type = 'false-positive'",
      )
      .get(ruleId) as { c: number }
  ).c;
  return { total, truePositives, falsePositives };
}

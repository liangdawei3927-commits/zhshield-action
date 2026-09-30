// @zh/db — 共享 SQL 常量
// batch.ts / queries.ts 各持有一份逐字相同的 UPSERT，收敛为唯一来源，避免行为分叉。

/** debt_actions 行 UPSERT（单条与批量写入共用） */
export const DEBT_ACTION_UPSERT_SQL = `INSERT INTO debt_actions (project_id, action_id, status, module, category, issue_ids, interest_score, principal_estimate, roi, sprint, gate)
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
       updated_at = CURRENT_TIMESTAMP`;
-- 012 · 项目数据软删标记（R1 删项目清理链）
-- 依据：R1「删项目完整归还」需在删除前对项目关联数据打软删标记，
--       供审计/回滚使用。当前查询侧不加过滤（deleted_at 仅作标记，
--       不参与任何 SELECT 的 WHERE），仅审计/回滚时读取。
-- 范围：scores、scanning_results、debt_actions、debt_snapshots、sentinel_events
--       五张表各加 deleted_at DATETIME（允许 NULL，默认 NULL），并补基于
--       deleted_at 的索引（idx_<表名>_deleted）。
-- 说明：sentinel_events 的 created_at 为 TEXT with datetime('now') 默认，
--       deleted_at 统一用 DATETIME 类型即可（与其余表一致）。
-- 纪律：experiences 是全局校准样本库，不随项目删除（06 §2.4），不加 deleted_at。

ALTER TABLE scores ADD COLUMN deleted_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_scores_deleted ON scores(deleted_at);

ALTER TABLE scanning_results ADD COLUMN deleted_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_scanning_results_deleted ON scanning_results(deleted_at);

ALTER TABLE debt_actions ADD COLUMN deleted_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_debt_actions_deleted ON debt_actions(deleted_at);

ALTER TABLE debt_snapshots ADD COLUMN deleted_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_debt_snapshots_deleted ON debt_snapshots(deleted_at);

ALTER TABLE sentinel_events ADD COLUMN deleted_at DATETIME;
CREATE INDEX IF NOT EXISTS idx_sentinel_events_deleted ON sentinel_events(deleted_at);

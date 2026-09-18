/**
 * 备份保留策略 — 单一来源
 *
 * 自动清理必须遵守的两条硬规则（2026-09-18 落地）：
 *
 * 1. **永不删光**：任何配置下都至少保留最新 1 份备份。
 * 2. **配置不得越界**：0 / 负数 / NaN / Infinity 一律规范化到安全区间。
 *
 * 背景：轮换删除曾在三处各写一份 `dirs.slice(maxBackups)`
 * （`LocalBackupPruner`、`LocalBackup.pruneOldBackups`、`BackupManager.pruneOldBackups`）。
 * 而 `listBackups()` 返回的是**新→旧**排序，于是 `maxBackups = 0` 时
 * `slice(0)` = 整个数组 —— 一次误配置就把所有备份删干净。
 * `defaultMaxBackups` 是 UI 可改项，填 0 并不困难。
 *
 * 判据：**份数与容量是硬约束，天数是软策略。** 这里守的是硬的那一端；
 * 天数保留是展示层的事（`page.reports` 的数据时间标注），不写进删除逻辑。
 */

/** 自动清理的绝对下限：任何策略下都必须保留的最新备份份数 */
export const MIN_BACKUP_KEEP = 1;

/**
 * 把「保留份数」规范化到安全区间。
 *
 * - 非数字 / 非有限数（undefined、null、NaN、Infinity、字符串）→ 取 `fallback`
 * - 小于 `MIN_BACKUP_KEEP` 的值（含 0 与负数）→ 抬到 `MIN_BACKUP_KEEP`
 * - 小数 → 向下取整
 *
 * 失败方向刻意朝「留得更多」：宁可多占磁盘，也不能删光用户的备份。
 */
export function normalizeKeepCount(raw: unknown, fallback: number = MIN_BACKUP_KEEP): number {
  const candidate = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  const n = Number.isFinite(candidate) ? candidate : MIN_BACKUP_KEEP;
  return Math.max(MIN_BACKUP_KEEP, Math.trunc(n));
}

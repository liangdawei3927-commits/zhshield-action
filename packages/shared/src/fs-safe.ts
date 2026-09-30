import * as fs from 'node:fs';

/**
 * 安全列目录：返回 `withFileTypes` 的目录项；目录不可读（权限不足、扫描途中被删除）时返回空数组。
 *
 * 递归扫描器此前在每个实现里重复同一段 `let entries; try { readdirSync } catch { return; }`，
 * 与 garbage-scan / security 域的 walk 实现逐字重复。此处收敛为唯一实现，
 * 语义与原实现一致（读取失败 = 该目录无可遍历项，不向上抛错）。
 */
export function safeReadDirEntries(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

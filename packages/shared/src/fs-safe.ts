import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 展开路径开头的 `~` 为用户 home 目录。
 *
 * 配置里的备份目录形如 `~/zhshield-backups/<project>`，是**字面量 `~`**（
 * `BackupConfigManager` 原样读写，不做展开）。任何把它交给 `path.resolve()`
 * 的地方都必须先经过本函数 —— `resolve('~/x')` 得到的是 `<cwd>/~/x`，不是 home。
 *
 * 2026-10-24 实证：`backup:openFolder` 的包含性校验用 `resolve(backupDir)` 求备份根，
 * 而同一路径的打开端自行展开 `~`，两侧口径不一致导致校验恒假、所有备份目录都打不开
 * （表现为「路径可能已被清理」）。
 */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

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

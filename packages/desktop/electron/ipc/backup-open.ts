/**
 * 打开备份目录（从 ipc/backup.ts 按功能域拆出）
 *
 * 目录回退解析 + 备份根包含性校验 + 文件高亮 / 目录打开。
 * 渲染层传来的路径不可信（逐字来自 backup-records.json），开目录前必须校验。
 */
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expandHome, safeResolveReal } from '@zh/shared';
import { BackupConfigManager, DEFAULT_BACKUP_ROOT } from '@zh/kernel';

/** 解析打开目标：快照目录可能已被 maxBackups 轮换清理，回退到其所在备份根目录 */
async function resolveOpenTarget(folderPath: string): Promise<string | null> {
  let target = expandHome(folderPath);
  try {
    await stat(target);
  } catch {
    const parent = join(target, '..');
    try {
      await stat(parent);
    } catch {
      return null;
    }
    target = parent;
  }
  return target;
}

/** zip 归档快照是文件而非目录：在 Finder 中高亮显示，避免 openPath 触发解压 */
async function revealOrOpenTarget(target: string): Promise<boolean> {
  const { shell } = await import('electron');
  if ((await stat(target)).isFile()) {
    shell.showItemInFolder(target);
    return true;
  }
  // shell.openPath 失败不抛异常而是 resolve 错误字符串，必须检查返回值而非 try/catch
  const errMsg = await shell.openPath(target);
  return !errMsg;
}

/**
 * 解析该项目的备份根目录（含向上回退，用于定位被轮转清理掉的快照所在根）。
 *
 * 渲染层传来的 folderPath 完全不可信：它逐字取自 <userData>/backup-records.json，
 * 该文件只被 JSON.parse 而无任何校验。篡改该文件即可让一次点击把 Finder 指向
 * 任意绝对路径，因此开目录前必须确认目标仍落在备份根内。
 */
async function resolveBackupRoots(projectPath: string): Promise<string[]> {
  const roots = new Set<string>();
  try {
    const config = await new BackupConfigManager().loadProjectConfig(projectPath);
    // backupDir 是配置里的字面量（形如 `~/zhshield-backups/<project>`），必须先展开 `~`
    // 再 resolve —— 否则根会变成 `<cwd>/~/zhshield-backups/...`，与真实快照路径永不包含。
    if (config?.local?.backupDir) roots.add(resolve(expandHome(config.local.backupDir)));
  } catch {
    /* 配置不可读时下方回退到默认根 */
  }
  roots.add(resolve(expandHome(DEFAULT_BACKUP_ROOT)));
  // 不接纳「根的父级」：快照形如 <root>/<project>/<snapshot>，resolveOpenTarget 的
  // 单层回退目标是 <root>/<project>，本就在根内。若把父级也列为合法根，同级任意
  // 目录（如 /tmp）都会被放行，包含性校验形同虚设。
  return [...roots];
}

/** 目标是否位于任一备份根之内（含符号链接判定，逃逸则拒绝）。导出以便单测直接验证。 */
export function isInsideBackupRoots(target: string, roots: string[]): boolean {
  return roots.some((root) => {
    try {
      safeResolveReal(root, target);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 打开备份目录（backup:openFolder）：目录回退解析 + 包含性校验 + 文件高亮 / 目录打开。
 *
 * 导出 openBackupFolder 而非只导出判定函数：真正的修复点是「调用前先校验」这一环，
 * 只测判定函数无法证明校验确实接在开目录路径上（曾出现删除守卫后测试仍全绿）。
 */
export async function openBackupFolder(
  projectPath: string,
  folderPath: string,
): Promise<boolean> {
  if (!folderPath || typeof folderPath !== 'string') return false;
  const target = await resolveOpenTarget(folderPath);
  if (target === null) return false;
  if (!isInsideBackupRoots(target, await resolveBackupRoots(projectPath))) {
    console.warn('[backup] 拒绝打开备份根之外的路径:', target);
    return false;
  }
  return revealOrOpenTarget(target);
}

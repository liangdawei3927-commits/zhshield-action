/**
 * 一键应用自动修复的落盘支撑（auto-fix-apply.ts）
 *
 * `auto-fix.ts` 负责「生成编辑」，本文件负责「写盘前把目标文件整体备份」。
 * 二者共同支撑 `RefactorEngine.applyAutoFixes`：任何自动改写都先留可回滚副本，
 * 与垃圾清理（garbage clean / restore）同构 —— 破坏性动作必须可撤销。
 *
 * 边界：只备份**位于被扫描项目根之内**的文件；越界路径（`..` / 绝对路径）一律跳过，
 * 既不备份也不返回 —— 生成器本就不该产出项目外编辑，这里是最后一道防线。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';
import type { Fix } from './types';

/** 备份根目录（相对被扫描项目根） */
const BACKUP_ROOT = ['.zhshield', 'backups'] as const;

/** 从修复集合收集去重后的目标文件（绝对路径） */
export function collectFixTargetFiles(fixes: readonly Fix[]): string[] {
  const seen = new Set<string>();
  for (const fix of fixes) {
    for (const edit of fix.edits) seen.add(edit.filePath);
  }
  return [...seen];
}

/** 判断相对路径是否安全地落在项目根内（非绝对、不以 .. 逃逸） */
function isInsideProject(rel: string): boolean {
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 备份单个文件到备份目录；成功返回相对路径，越界/不存在返回 null */
function backupOneFile(filePath: string, projectRoot: string, backupDir: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const rel = path.relative(projectRoot, filePath);
  if (!isInsideProject(rel)) return null;
  const dest = safeJoin(backupDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(filePath, dest);
  return rel;
}

/**
 * 备份所有修复目标文件。
 *
 * @param fixes 生成的修复编辑集合
 * @param projectRoot 被扫描项目根（绝对路径）
 * @param stamp 时间戳串（用于生成唯一备份目录名，调用方传入以便测试可控）
 * @returns 备份目录（无文件被备份时为 null）与已备份的相对路径列表
 */
export function backupFixTargets(
  fixes: readonly Fix[],
  projectRoot: string,
  stamp: string,
): { backupDir: string | null; backedUpFiles: string[] } {
  const targets = collectFixTargetFiles(fixes);
  const backupDir = path.join(projectRoot, ...BACKUP_ROOT, `refactor-autofix-${stamp}`);
  const backedUpFiles: string[] = [];
  for (const filePath of targets) {
    const rel = backupOneFile(filePath, projectRoot, backupDir);
    if (rel !== null) backedUpFiles.push(rel);
  }
  return { backupDir: backedUpFiles.length > 0 ? backupDir : null, backedUpFiles };
}

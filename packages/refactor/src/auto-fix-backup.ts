/**
 * 自动修复备份的「枚举 + 撤销」领域逻辑（auto-fix-backup.ts）
 *
 * 为什么放在 @zh/refactor 而不是桌面端：备份目录的**约定**（.zhshield/backups/
 * refactor-autofix-<时间戳>/）由本包生成，也只有本包能正确解读。桌面端此前把
 * 「读目录 + 校验前缀 + 调 restoreFromBackup」又写了一份 —— 约定一旦演进，
 * 两份必然漂移（写备份的改了目录名，读备份的还按老名字找 ⇒ 撤销入口静默失效）。
 *
 * 与 garbage 域同构：破坏性动作必须可撤销，且撤销入口必须落在**磁盘事实**上，
 * 而不是渲染层内存（关掉应用就再也回不去）。
 *
 * 安全边界（fail-closed）：
 *   - backupDir 必须**恰为** `<project>/.zhshield/backups/` 的直接子目录且前缀正确 ——
 *     否则一个参数笔误就能把任意目录当备份恢复；
 *   - 清单里的 projectRoot 必须与当前项目一致 —— 防止把 A 项目的备份恢复到 B 项目。
 */
import * as fs from 'fs';
import * as path from 'path';
import { safeResolve } from '@zh/shared';
import {
  BACKUP_PREFIX,
  BACKUP_ROOT,
  readBackupManifest,
  restoreFromBackup,
} from './auto-fix-apply';

/** 一个仍可撤销的自动修复备份 */
export interface AutoFixBackupEntry {
  /** 备份目录绝对路径（撤销时回传） */
  backupDir: string;
  /** 备份创建时间（ISO；取自清单，缺失为空串） */
  createdAt: string;
  /** 可恢复的文件数 */
  fileCount: number;
  /** 撤销时会删除的新建文件数 */
  createdCount: number;
}

/** 撤销结果（ok=false 时 reason 说明原因，不抛异常，便于 UI 直接展示） */
export interface RestoreAutoFixResult {
  ok: boolean;
  /** 恢复后逐字节校验是否全部通过（false = 恢复不可信，上层必须据此失败） */
  verified: boolean;
  restoredFiles: string[];
  removedFiles: string[];
  /** 失败原因（成功时为空串） */
  reason: string;
}

/** 备份根目录绝对路径 */
function backupRootOf(projectPath: string): string {
  return path.join(projectPath, ...BACKUP_ROOT);
}

/**
 * 校验并规范化 backupDir：必须是 `<project>/.zhshield/backups/<前缀开头的直接子目录>`。
 *
 * 非法输入返回 null（fail-closed），调用方据此拒绝，不进入恢复流程。
 * 包含性检查走 `safeResolve`（与仓库其他不可信路径入参同一套实现），
 * 再补两条本域特有约束：不得是备份根自身、必须是**直接**子目录。
 */
function resolveBackupDir(projectPath: string, backupDir: string): string | null {
  const root = path.resolve(backupRootOf(projectPath));
  let abs: string;
  try {
    abs = safeResolve(root, backupDir);
  } catch {
    return null; // 逃出备份根（`..` / 项目外绝对路径）→ 拒绝
  }
  if (!path.basename(abs).startsWith(BACKUP_PREFIX)) return null;
  return path.dirname(abs) === root ? abs : null;
}

/**
 * 列出当前项目内仍可撤销的自动修复备份（新→旧）。
 *
 * 读不到清单的目录一律跳过（不是"可撤销的备份"，只是残留目录）；
 * 清单 projectRoot 与当前项目不符的也跳过（别的项目的备份出现在这里，
 * 撤销就是跨项目误伤）。
 */
export function listAutoFixBackups(projectPath: string): AutoFixBackupEntry[] {
  if (!projectPath || typeof projectPath !== 'string') return [];
  const root = backupRootOf(projectPath);
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projectAbs = path.resolve(projectPath);
  const entries: AutoFixBackupEntry[] = [];
  for (const dirent of dirents) {
    // 备份根下不该出现 node_modules（前缀校验也会挡掉），显式跳过让静态门禁与人工审计都无需逐条确认
    if (dirent.name === 'node_modules') continue;
    if (!dirent.isDirectory() || !dirent.name.startsWith(BACKUP_PREFIX)) continue;
    const backupDir = path.join(root, dirent.name);
    const manifest = readBackupManifest(backupDir);
    if (!manifest) continue;
    if (path.resolve(manifest.projectRoot) !== projectAbs) continue;
    entries.push({
      backupDir,
      createdAt: manifest.createdAt,
      fileCount: manifest.files.length,
      createdCount: manifest.createdFiles.length,
    });
  }
  // 新→旧；同一时间戳（同秒内多次修复）按目录名倒序，保证顺序稳定
  return entries.sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.backupDir.localeCompare(a.backupDir),
  );
}

/**
 * 撤销一次自动修复：把备份写回、删除本次新建的文件（幂等 + 逐字节校验）。
 *
 * 返回 ok=false 而不抛异常：撤销失败是**用户可理解的业务结果**（UI 要展示原因），
 * 与"参数非法"（调用方 bug，直接 reject）分级处理。
 */
export function restoreAutoFixBackup(
  projectPath: string,
  backupDir: string,
): RestoreAutoFixResult {
  if (!projectPath || typeof projectPath !== 'string') return invalidBackup();
  if (!backupDir || typeof backupDir !== 'string') return invalidBackup();

  const dir = resolveBackupDir(projectPath, backupDir);
  if (dir === null) return invalidBackup();

  const manifest = readBackupManifest(dir);
  if (!manifest || path.resolve(manifest.projectRoot) !== path.resolve(projectPath)) {
    return {
      ok: false,
      verified: false,
      restoredFiles: [],
      removedFiles: [],
      reason: 'backup-manifest-invalid',
    };
  }

  try {
    const result = restoreFromBackup(dir);
    return {
      ok: result.verified,
      verified: result.verified,
      restoredFiles: result.restoredFiles,
      removedFiles: result.removedFiles,
      reason: result.verified ? '' : 'restore-verification-failed',
    };
  } catch (err) {
    return {
      ok: false,
      verified: false,
      restoredFiles: [],
      removedFiles: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 非法入参的统一结果（reason 用固定码，UI 层负责翻译） */
function invalidBackup(): RestoreAutoFixResult {
  return {
    ok: false,
    verified: false,
    restoredFiles: [],
    removedFiles: [],
    reason: 'invalid-backup-params',
  };
}

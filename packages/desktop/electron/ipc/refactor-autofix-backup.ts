/**
 * 自动修复备份的「列出 + 撤销」IPC 支撑（报告 §5.5 的用户侧闭环）。
 *
 * 背景：`engine:applyRefactorFixes` 写盘前已把目标文件备份到
 * `<项目>/.zhshield/backups/refactor-autofix-<时间戳>/`（含 manifest.json）。
 * 但此前**没有任何用户入口**能回到那个备份 —— "可回滚"只是后端能力，
 * 用户关掉应用或换个会话就再也看不到撤销按钮。本模块把备份变成可枚举、可撤销的事实：
 *   - listRefactorAutoFixBackups：读 manifest 列出仍可撤销的备份（跨会话有效）；
 *   - restoreRefactorAutoFix：校验路径边界后调用 @zh/refactor 的 restoreFromBackup，
 *     幂等恢复 + 逐字节校验（与 CLI/桌面的"破坏性动作必须可撤销"同构）。
 *
 * 安全边界（fail-closed）：
 *   - backupDir 必须**恰为** `<project>/.zhshield/backups/` 的直接子目录且前缀正确 ——
 *     否则渲染层一个笔误就能把任意目录当备份恢复；
 *   - 清单里的 projectRoot 必须与当前项目一致 —— 防止把 A 项目的备份恢复到 B 项目。
 */
import * as fs from 'fs';
import * as path from 'path';
import { ipcMain } from 'electron';
import { t } from '@zh/i18n';
import { readBackupManifest, restoreFromBackup } from '@zh/refactor';

/** 备份根目录（相对项目根；与 @zh/refactor 的 BACKUP_ROOT 同口径） */
const BACKUP_ROOT = ['.zhshield', 'backups'] as const;
/** 自动修复备份目录名前缀（与 @zh/refactor 生成时一致） */
const BACKUP_PREFIX = 'refactor-autofix-';

/** 一个仍可撤销的自动修复备份 */
export interface RefactorAutoFixBackupEntry {
  /** 备份目录绝对路径（撤销时回传） */
  backupDir: string;
  /** 备份创建时间（ISO；取自清单，缺失为空串） */
  createdAt: string;
  /** 可恢复的文件数 */
  fileCount: number;
  /** 撤销时会删除的新建文件数 */
  createdCount: number;
}

/** 撤销结果（ok=false 时 message 说明原因，不抛异常，便于 UI 直接展示） */
export interface RestoreRefactorAutoFixResult {
  ok: boolean;
  verified: boolean;
  restoredFiles: string[];
  removedFiles: string[];
  message: string;
}

/** 备份根目录绝对路径 */
function backupRootOf(projectPath: string): string {
  return path.join(projectPath, ...BACKUP_ROOT);
}

/**
 * 校验并规范化 backupDir：必须是 `<project>/.zhshield/backups/<前缀开头的直接子目录>`。
 * 非法输入直接抛错（fail-closed），不进入恢复流程。
 */
function resolveBackupDir(projectPath: string, backupDir: string): string {
  const root = path.resolve(backupRootOf(projectPath));
  const abs = path.resolve(backupDir);
  const rel = path.relative(root, abs);
  const isDirectChild = rel !== '' && !rel.includes(path.sep) && !path.isAbsolute(rel);
  if (!isDirectChild || rel.startsWith('..') || !path.basename(abs).startsWith(BACKUP_PREFIX)) {
    throw new Error(t('electron.invalidParams'));
  }
  return abs;
}

/** 列出当前项目内仍可撤销的自动修复备份（新→旧）。读不到清单的目录一律跳过。 */
export function listRefactorAutoFixBackups(projectPath: string): RefactorAutoFixBackupEntry[] {
  if (!projectPath || typeof projectPath !== 'string') return [];
  const root = backupRootOf(projectPath);
  if (!fs.existsSync(root)) return [];
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projectAbs = path.resolve(projectPath);
  const entries: RefactorAutoFixBackupEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !dirent.name.startsWith(BACKUP_PREFIX)) continue;
    const backupDir = path.join(root, dirent.name);
    const manifest = readBackupManifest(backupDir);
    if (!manifest) continue;
    // 只列属于本项目的备份：别的项目的备份出现在这里，撤销就是跨项目误伤
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
 * 与"参数非法"（渲染层 bug，直接 reject）分级处理。
 */
export function restoreRefactorAutoFix(
  projectPath: string,
  backupDir: string,
): RestoreRefactorAutoFixResult {
  if (
    !projectPath ||
    typeof projectPath !== 'string' ||
    !backupDir ||
    typeof backupDir !== 'string'
  ) {
    throw new Error(t('electron.invalidParams'));
  }
  const dir = resolveBackupDir(projectPath, backupDir);
  const manifest = readBackupManifest(dir);
  if (!manifest || path.resolve(manifest.projectRoot) !== path.resolve(projectPath)) {
    return {
      ok: false,
      verified: false,
      restoredFiles: [],
      removedFiles: [],
      message: t('electron.restoreFailed'),
    };
  }
  try {
    const result = restoreFromBackup(dir);
    return {
      ok: result.verified,
      verified: result.verified,
      restoredFiles: result.restoredFiles,
      removedFiles: result.removedFiles,
      message: result.verified
        ? t('page.refactor.autoFix.undoDone', { count: result.restoredFiles.length })
        : t('electron.restoreFailed'),
    };
  } catch (err) {
    return {
      ok: false,
      verified: false,
      restoredFiles: [],
      removedFiles: [],
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 注册撤销闭环的 IPC handler。
 *
 * 单独成文件而不是塞进 engines.ts：engines.ts 已在 400 行阈值边缘，
 * 再加只会推它过线（文件体积本身是门禁项，见 oversized-file 规则）。
 */
export function registerRefactorAutoFixBackupHandlers(): void {
  ipcMain.handle('engine:listRefactorAutoFixBackups', (_e, projectPath: string) =>
    listRefactorAutoFixBackups(projectPath),
  );
  ipcMain.handle('engine:restoreRefactorAutoFix', (_e, projectPath: string, backupDir: string) =>
    restoreRefactorAutoFix(projectPath, backupDir),
  );
}

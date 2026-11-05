/**
 * 自动修复备份的「列出 + 撤销」IPC 支撑（报告 §5.5 的用户侧闭环）。
 *
 * 背景：`engine:applyRefactorFixes` 写盘前已把目标文件备份到
 * `<项目>/.zhshield/backups/refactor-autofix-<时间戳>/`（含 manifest.json）。
 * 用户关掉应用、隔天回来仍要能撤销 —— 撤销入口必须是磁盘上可枚举的事实，
 * 不能是渲染层内存状态。
 *
 * 分工（三层，别混回去）：
 *   1. **目录约定 + 清单解读 + 路径边界校验**：只在 `@zh/refactor` 一份。
 *      写备份与读备份必须同源 —— 以前这里又写了一份「读目录 + 校验前缀 +
 *      调 restoreFromBackup」，约定一演进就是一边改名、另一边按老名字找不到，
 *      撤销入口静默失效且没有任何报错。
 *   2. **读盘 / 写盘**：一律在引擎子进程（主进程禁止 fs 同步 IO —— no-fs-sync 门禁；
 *      且同步扫盘会阻塞 Electron 主线程出「macOS 彩球」）。
 *   3. **本文件**：派发子进程 + 把子进程回传的 reason 码翻成用户文案。
 */
import { ipcMain } from 'electron';
import { t } from '@zh/i18n';
import type { RestoreAutoFixResult } from '@zh/refactor';
import type {
  RefactorAutoFixBackupEntryData,
  RestoreRefactorAutoFixResultData,
} from '../../src/types/electron';
import {
  listRefactorAutoFixBackupsInWorker,
  restoreRefactorAutoFixInWorker,
} from '../pipeline-host';

/** 撤销失败原因码 → 用户文案（领域层只回码，翻译留在主进程，语言切换不影响判据） */
const RESTORE_REASON_TEXT: Readonly<Record<string, string>> = {
  'invalid-backup-params': 'electron.invalidParams',
  'backup-manifest-invalid': 'electron.restoreFailed',
  'restore-verification-failed': 'electron.restoreFailed',
};

/**
 * 列出仍可撤销的自动修复备份（新→旧）。
 *
 * 列不出备份不是致命错误：调用方（渲染层）据此隐藏撤销入口，页面照常可用。
 */
export async function listRefactorAutoFixBackupsHandler(
  projectPath: string,
): Promise<RefactorAutoFixBackupEntryData[]> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  const entries = (await listRefactorAutoFixBackupsInWorker(projectPath)) as
    | RefactorAutoFixBackupEntryData[]
    | undefined;
  return Array.isArray(entries) ? entries : [];
}

function reasonText(reason: string): string {
  const key = RESTORE_REASON_TEXT[reason];
  // 未登记的 reason 是恢复过程里抛上来的原始错误信息，直接透出比换成"恢复失败"更有用
  return key ? t(key) : reason || t('electron.restoreFailed');
}

function toRestoreResult(
  result: Partial<RestoreAutoFixResult> | undefined,
): RestoreRefactorAutoFixResultData {
  const restoredFiles = Array.isArray(result?.restoredFiles) ? result.restoredFiles : [];
  const removedFiles = Array.isArray(result?.removedFiles) ? result.removedFiles : [];
  const ok = result?.ok === true;
  return {
    ok,
    verified: result?.verified === true,
    restoredFiles,
    removedFiles,
    message: ok
      ? t('page.refactor.autoFix.undoDone', { count: restoredFiles.length })
      : reasonText(String(result?.reason ?? '')),
  };
}

/**
 * 撤销一次自动修复（按备份恢复：写回备份 + 删除本次新建文件 + 逐字节校验）。
 *
 * 只有**参数类型**在本地抛（调用方 bug）；路径边界与清单校验由领域层 fail-closed 判定，
 * 以 ok=false 返回 —— 撤销失败是用户可理解的业务结果，UI 要展示原因而不是红条。
 */
export async function restoreRefactorAutoFixHandler(
  projectPath: string,
  backupDir: string,
): Promise<RestoreRefactorAutoFixResultData> {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error(t('electron.invalidProjectPath'));
  }
  if (!backupDir || typeof backupDir !== 'string') {
    throw new Error(t('electron.invalidParams'));
  }
  const result = (await restoreRefactorAutoFixInWorker(projectPath, backupDir)) as
    | RestoreAutoFixResult
    | undefined;
  return toRestoreResult(result);
}

/**
 * 注册撤销闭环的 IPC handler。
 *
 * 单独成文件而不是塞进 engines.ts：engines.ts 已在 400 行阈值边缘，
 * 再加只会推它过线（文件体积本身是门禁项，见 oversized-file 规则）。
 */
export function registerRefactorAutoFixBackupHandlers(): void {
  ipcMain.handle('engine:listRefactorAutoFixBackups', (_e, projectPath: string) =>
    listRefactorAutoFixBackupsHandler(projectPath),
  );
  ipcMain.handle('engine:restoreRefactorAutoFix', (_e, projectPath: string, backupDir: string) =>
    restoreRefactorAutoFixHandler(projectPath, backupDir),
  );
}

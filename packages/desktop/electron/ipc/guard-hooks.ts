/**
 * 门禁 git hooks IPC（ipc/guard-hooks.ts）
 *
 * 安装 / 查询 / 卸载 pre-commit + pre-push 门禁钩子。
 * 已有钩子文件时不覆盖（避免破坏用户现有 git hooks）。
 */

import { ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { t } from '@zh/i18n';
import { HooksInstaller, listGuardReports } from '@zh/guard';
import type { GuardReportRecord } from '@zh/guard';

interface GuardHooksStatus {
  hasGitDir: boolean;
  installed: string[];
}

function createInstaller(projectPath: string): HooksInstaller {
  return new HooksInstaller(projectPath);
}

function getStatus(installer: HooksInstaller): GuardHooksStatus {
  return {
    hasGitDir: installer.hasGitDir(),
    installed: installer.listInstalledHooks(),
  };
}

/** 已存在的钩子文件清单（含第三方钩子），这些文件不能被覆盖 */
async function existingHookFiles(projectPath: string): Promise<string[]> {
  const hooksDir = path.join(projectPath, '.git', 'hooks');
  const known = ['pre-commit', 'pre-push', 'post-commit'];
  try {
    return (await fs.readdir(hooksDir)).filter((f) => known.includes(f));
  } catch {
    return [];
  }
}

function registerHooksStatusHandler(): void {
  ipcMain.handle('guard:hooksStatus', (_event, projectPath: string): GuardHooksStatus => {
    if (!projectPath || typeof projectPath !== 'string') {
      return { hasGitDir: false, installed: [] };
    }
    return getStatus(createInstaller(projectPath));
  });
}

function registerListReportsHandler(): void {
  ipcMain.handle(
    'guard:listReports',
    (_event, projectPath: string, limit?: number): GuardReportRecord[] => {
      if (!projectPath || typeof projectPath !== 'string') return [];
      return listGuardReports(projectPath, limit ?? 20);
    },
  );
}

function registerInstallHooksHandler(): void {
  ipcMain.handle(
    'guard:installHooks',
    async (
      _event,
      projectPath: string,
    ): Promise<{ ok: boolean; installed: string[]; skipped: string[]; reason?: string }> => {
      if (!projectPath || typeof projectPath !== 'string') {
        return { ok: false, installed: [], skipped: [], reason: t('electron.invalidProjectPath') };
      }
      const installer = createInstaller(projectPath);
      if (!installer.hasGitDir()) {
        return { ok: false, installed: [], skipped: [], reason: t('electron.notGitRepo') };
      }

      const existing = await existingHookFiles(projectPath);
      if (existing.length > 0) {
        return {
          ok: false,
          installed: [],
          skipped: existing,
          reason: t('electron.hooksExist', { hooks: existing.join(', ') }),
        };
      }

      const installed = await installer.install();
      return { ok: installed.length > 0, installed, skipped: [] };
    },
  );
}

function registerUninstallHooksHandler(): void {
  ipcMain.handle(
    'guard:uninstallHooks',
    async (_event, projectPath: string): Promise<{ ok: boolean; removed: string[] }> => {
      if (!projectPath || typeof projectPath !== 'string') {
        return { ok: false, removed: [] };
      }
      const installer = createInstaller(projectPath);
      const removed = await installer.uninstall();
      return { ok: removed.length > 0, removed };
    },
  );
}

export function registerGuardHooksIpc(): void {
  registerHooksStatusHandler();
  registerListReportsHandler();
  registerInstallHooksHandler();
  registerUninstallHooksHandler();
}

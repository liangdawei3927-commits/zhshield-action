/**
 * 引擎 API 分片 — 门禁 git hooks：安装状态查询、安装、卸载与门禁报告列表
 *
 * 全部走 Electron IPC（guardHooks 通道），preload 桥接缺失时返回空降级值。
 */
import { t } from '@zh/i18n';
import type { GuardReportRecordData } from '../types/electron';
import { getAPI } from './engineApi-transport';

// ─── 门禁 git hooks（本地自动守护）─────────────────────────

/** 门禁 git hooks 安装状态：是否为 git 仓库 + 已安装的 hook 脚本列表 */
export interface GuardHooksStatusData {
  hasGitDir: boolean;
  installed: string[];
}

/** 门禁 git hooks 安装结果：成功标记、已安装/跳过列表与失败原因 */
export interface GuardHooksInstallResultData {
  ok: boolean;
  installed: string[];
  skipped: string[];
  reason?: string;
}

/**
 * 查询 git hooks 安装状态。
 *
 * IPC handler（`guard:hooksStatus`）与 preload 桥接均已实现，UI 尚未接入消费方。
 * ts-prune 会将本导出报告为「未使用」，但这不代表可删除——删除会连带作废
 * electron 侧已完成的 guard:hooksStatus 能力。
 */
export async function getGuardHooksStatus(projectPath: string): Promise<GuardHooksStatusData> {
  const api = getAPI();
  if (!api?.guardHooks) return { hasGitDir: false, installed: [] };
  return api.guardHooks.getStatus(projectPath);
}

export async function installGuardHooks(projectPath: string): Promise<GuardHooksInstallResultData> {
  const api = getAPI();
  if (!api?.guardHooks)
    return { ok: false, installed: [], skipped: [], reason: t('engine.hooksUnavailable') };
  return api.guardHooks.install(projectPath);
}

/**
 * 卸载 git hooks。`guard:uninstallHooks` handler 与 preload 桥接已实现，UI 尚未接入。
 * 卸载 git hooks。`guardHooks.uninstall` preload 桥接与 `guard:uninstallHooks` handler
 * 已实现，UI 未接入，故 ts-prune 报为未使用。
 */
export async function uninstallGuardHooks(
  projectPath: string,
): Promise<{ ok: boolean; removed: string[] }> {
  const api = getAPI();
  if (!api?.guardHooks) return { ok: false, removed: [] };
  return api.guardHooks.uninstall(projectPath);
}

export async function listGuardReports(
  projectPath: string,
  limit = 20,
): Promise<GuardReportRecordData[]> {
  const api = getAPI();
  if (!api?.guardHooks) return [];
  return api.guardHooks.listReports(projectPath, limit);
}

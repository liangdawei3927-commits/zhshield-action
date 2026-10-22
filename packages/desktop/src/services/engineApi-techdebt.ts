/**
 * 引擎 API 分片 — Tech Debt 技术债动作：还款计划、核销验证与忽略
 *
 * 走 Electron IPC，引擎不可用时静默降级（不 throw）。
 */
import { getAPI } from './engineApi-transport';

export async function planDebtRepayment(
  projectPath: string,
  actionId: string,
  opts?: { sprint?: string; gate?: 'allow-with-record' },
): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.planDebtRepayment(projectPath, actionId, opts);
}

export async function verifyDebtRepaid(projectPath: string, actionId: string): Promise<boolean> {
  const api = getAPI();
  if (!api?.engine) return false;
  return api.engine.verifyDebtRepaid(projectPath, actionId);
}

export async function dismissDebtAction(projectPath: string, actionId: string): Promise<void> {
  const api = getAPI();
  if (!api?.engine) return;
  return api.engine.dismissDebtAction(projectPath, actionId);
}

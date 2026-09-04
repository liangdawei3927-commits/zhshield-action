/**
 * T1 云端规则对账（ipc/resolve-reconcile.ts）
 *
 * 免维护同步的对账编排层：
 * 1. 以本地规则 contentSha 为 currentVersions 调 POST /resolve/rules
 * 2. 用 kernel 纯函数校验器比对云端生效清单（missing / shaMismatch / unexpected）
 * 3. 有漂移时触发 sopCache.syncFromCloud() 自愈（版本一致时为 no-op），随后复检
 *
 * 降级纪律：无 org / 云端不可达 → 返回 ok:false，永不阻断本地同步与体检。
 * 触发源：启动后首跑 + 与 SOP 定时同步同频的循环（startResolveReconcileTimer）
 * + 手动同步（sop:syncNow）+ 画像漂移（profile-drift）。
 */

import type { SopRule } from '@zh/kernel';
import { buildCurrentVersions, verifyRuleManifest, needsHeal } from '@zh/kernel';

import {
  getCachedProfile,
  getDefaultOrgId,
  cloudResolveRules,
  sopCache,
  sopRegistry,
  type ScopeProfileLike,
} from '../ipc-context';

/** /resolve/rules 对账结果（渲染层可见；旧字段 total/changed 向后兼容保留） */
export interface ResolveRulesOutcome {
  ok: boolean;
  reason?: 'no_org' | 'cloud_error';
  /** 云端生效规则数 */
  total: number;
  /** 云端判定的差量规则 ID */
  changed: string[];
  /** 云端有、本地无 */
  missing: string[];
  /** 内容哈希不一致 */
  shaMismatch: string[];
  /** 本地多出（仅观测） */
  unexpected: string[];
  /** 是否触发过自愈同步 */
  healed: boolean;
}

const EMPTY_OUTCOME = {
  total: 0,
  changed: [] as string[],
  missing: [] as string[],
  shaMismatch: [] as string[],
  unexpected: [] as string[],
  healed: false,
};

function localActiveRules(): SopRule[] {
  return sopRegistry.getActive();
}

/**
 * 对账主流程：云端 resolve → 清单校验 → 漂移自愈 → 复检。
 * 任何失败都收敛为 ok:false 降级结果，不抛出。
 */
export async function reconcileRulesWithCloud(): Promise<ResolveRulesOutcome> {
  const feature = getCachedProfile() ?? undefined;

  let orgId: string | null = null;
  try {
    orgId = await getDefaultOrgId();
  } catch {
    orgId = null;
  }
  if (!orgId) {
    return { ok: false, reason: 'no_org', ...EMPTY_OUTCOME };
  }

  const rules = localActiveRules();
  try {
    const res = await cloudResolveRules(
      orgId,
      feature as ScopeProfileLike | undefined,
      buildCurrentVersions(rules),
    );
    let report = verifyRuleManifest(rules, res.rules);
    let healed = false;

    if (needsHeal(report)) {
      // 自愈：全量/增量同步补齐（SOP 版本一致时为 no-op，不重复下载）
      try {
        await sopCache.syncFromCloud();
        healed = true;
      } catch (err) {
        console.warn(
          '[cloud:T1] 自愈同步失败（保持漂移状态，下轮对账重试）:',
          err instanceof Error ? err.message : String(err),
        );
      }
      if (healed) {
        report = verifyRuleManifest(localActiveRules(), res.rules);
      }
    }

    console.log(
      `[cloud:T1] /resolve/rules 对账: 生效 ${report.expected} 条, changed=${res.changed.length}, ` +
        `missing=${report.missing.length}, shaMismatch=${report.shaMismatch.length}, ` +
        `unexpected=${report.unexpected.length}${healed ? '（已自愈）' : ''}`,
    );
    return {
      ok: true,
      total: report.expected,
      changed: res.changed,
      missing: report.missing,
      shaMismatch: report.shaMismatch,
      unexpected: report.unexpected,
      healed,
    };
  } catch (err) {
    console.warn(
      '[cloud:T1] /resolve/rules 对账失败，降级本地:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: 'cloud_error', ...EMPTY_OUTCOME };
  }
}

const RECONCILE_STARTUP_DELAY_MS = 30_000;
/** 默认与桌面端 SOP 同步策略同频（ipc-context: syncInterval = 6 小时） */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 启动对账循环：启动 30s 后首跑，此后与 SOP 定时同步同频。
 * 幂等：重复调用不会创建多个定时器。fire-and-forget，永不阻断主流程。
 */
export function startResolveReconcileTimer(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (reconcileTimer) return;
  setTimeout(() => {
    void reconcileRulesWithCloud().catch(() => {});
  }, RECONCILE_STARTUP_DELAY_MS).unref?.();
  reconcileTimer = setInterval(() => {
    void reconcileRulesWithCloud().catch(() => {});
  }, intervalMs);
  reconcileTimer.unref?.();
}

/** 停止对账循环（测试 / 退出清理用） */
export function stopResolveReconcileTimer(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

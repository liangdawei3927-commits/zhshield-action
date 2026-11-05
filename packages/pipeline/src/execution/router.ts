/**
 * Router —— 执行层第三层（《07》§7.2 / §7.4）：`rawResult.ruleId → owner domain`。
 *
 * 两条契约在此落地：
 *   · C1/C2：每条 issue 只有一个 owner，只投递给该域，其余域拿不到（不重复扣分）。
 *   · Rule 12（fail loud）：解析不出 owner、或声明 owner 与注册表冲突的 finding
 *     **不得静默丢弃**，一律进 `unrouted[]` 并带原因；调用方必须上报。
 *
 * 每次投递都写一条 distribution 记录 `(ruleId, owner, fingerprint)`，供 A9/A10
 * 「全局 Σissues 与各域 Σissues 一致」比对。
 */
import { resolveOwnerId, type DomainId } from '@zh/shared';

/** 可路由的最小 finding 形状（其余字段由调用方泛型携带） */
export interface RoutableFinding {
  ruleId: string;
  fingerprint: string;
  /** 产出方自报的 owner；与注册表不一致即判冲突 */
  owner?: DomainId;
}

/** 未投递原因 */
export type UnroutedReason = 'no-owner' | 'owner-conflict';

/** 未投递条目：必须由调用方报告，不得丢弃 */
export interface UnroutedFinding<T> {
  finding: T;
  reason: UnroutedReason;
  detail: string;
}

/** 投递审计记录（C2 校验用） */
export interface DistributionRecord {
  ruleId: string;
  owner: DomainId;
  fingerprint: string;
}

export interface RouteResult<T> {
  /** 按域分桶；未出现的域没有 key，调用方据此判 `not-run` */
  byOwner: Partial<Record<DomainId, T[]>>;
  unrouted: UnroutedFinding<T>[];
  distribution: DistributionRecord[];
}

/**
 * 把一批原始 findings 按 owner 投递。
 *
 * @param findings 原始结果（同一份原始结果可被多个域共享，但每条只投给一个域）
 * @param resolve 自定义解析器（默认读 ownership-registry），便于测试与后续域内覆盖
 */
export function routeFindings<T extends RoutableFinding>(
  findings: readonly T[],
  resolve: (ruleId: string) => DomainId | null = resolveOwnerId,
): RouteResult<T> {
  const byOwner: Partial<Record<DomainId, T[]>> = {};
  const unrouted: UnroutedFinding<T>[] = [];
  const distribution: DistributionRecord[] = [];

  for (const finding of findings) {
    const resolved = resolve(finding.ruleId);

    if (resolved === null) {
      unrouted.push({
        finding,
        reason: 'no-owner',
        detail: `ruleId "${finding.ruleId}" 在归属注册表中无 owner`,
      });
      continue;
    }

    if (finding.owner !== undefined && finding.owner !== resolved) {
      unrouted.push({
        finding,
        reason: 'owner-conflict',
        detail: `finding 自报 owner=${finding.owner}，注册表裁定 ${resolved}`,
      });
      continue;
    }

    const bucket = byOwner[resolved];
    if (bucket) bucket.push(finding);
    else byOwner[resolved] = [finding];

    distribution.push({
      ruleId: finding.ruleId,
      owner: resolved,
      fingerprint: finding.fingerprint,
    });
  }

  return { byOwner, unrouted, distribution };
}

import type { EventBus } from '../../bus';
import type { SopRegistry } from '../_meta/sop-registry';
import type { SopRule } from '../_meta/sop-types';
import { ConflictResolution } from '../sync-conflict';
import type { SyncConflictResolver } from '../sync-conflict';
import type { SopCacheMetrics } from './sop-cache-metrics';

/** 规则稳定字段投影：剔除 createdAt/updatedAt/计数等易变元数据，使哈希只反映语义内容 */
function stableRuleProjection(rule: SopRule): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    domain: rule.domain,
    action: rule.action,
    source: rule.source,
    description: rule.description,
    status: rule.status,
    executionMode: rule.executionMode,
    severity: rule.severity,
    applicableEngines: rule.applicableEngines,
    content: rule.content,
    serves: rule.serves,
    tags: rule.tags,
  };
}

export interface SopConflictPolicyOptions {
  registry: SopRegistry;
  /** 云端/本地规则冲突解决器（sync-conflict 模块接入点）；缺省时保持既有覆盖语义 */
  resolver?: SyncConflictResolver;
  /** 冲突自动解决策略，默认 REMOTE_WINS（与既有「云端覆盖本地」行为一致） */
  strategy?: ConflictResolution;
  metrics?: SopCacheMetrics;
  eventBus?: EventBus;
}

/**
 * SopConflictPolicy — 云端/本地规则冲突检测与解决（sync-conflict 模块业务接入点）
 *
 * 以规则稳定字段的 SHA-256 判定内容是否真冲突，updatedAt 时间戳作为版本代理；
 * 无冲突（内容一致）时按原逻辑继续写入，有冲突时按策略解决后落库。
 */
export class SopConflictPolicy {
  private readonly registry: SopRegistry;
  private readonly resolver?: SyncConflictResolver;
  private readonly strategy: ConflictResolution;
  private readonly metrics?: SopCacheMetrics;
  private readonly eventBus?: EventBus;

  constructor(options: SopConflictPolicyOptions) {
    this.registry = options.registry;
    this.resolver = options.resolver;
    this.strategy = options.strategy ?? ConflictResolution.REMOTE_WINS;
    this.metrics = options.metrics;
    this.eventBus = options.eventBus;
  }

  resolveIncoming(incoming: SopRule): SopRule {
    const resolver = this.resolver;
    if (!resolver) return incoming;

    const local = this.registry.get(incoming.id);
    if (!local) return incoming;

    const conflict = resolver.detectConflict(
      incoming.id,
      local.updatedAt.getTime(),
      incoming.updatedAt.getTime(),
      stableRuleProjection(local),
      stableRuleProjection(incoming),
    );
    if (!conflict) return incoming;

    const resolved = resolver.resolve(conflict, this.strategy) as Partial<SopRule>;
    this.metrics?.recordConflictResolved(this.strategy);
    this.eventBus?.emit('sop:conflict-resolved', {
      ruleId: conflict.ruleId,
      strategy: this.strategy,
      localHash: conflict.localHash,
      remoteHash: conflict.remoteHash,
      timestamp: conflict.detectedAt,
    });
    return { ...incoming, ...resolved };
  }
}

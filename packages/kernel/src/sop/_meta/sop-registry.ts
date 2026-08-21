import type { EventBus } from '../../bus';
import type {
  SopRule,
  RuleServes,
  SopRuleFilter,
  SopRuleStats,
  GovernanceDomain,
  ActionType,
  RuleLifecycleStatus,
} from './sop-types';

export interface RuleChangeEvent {
  type: 'added' | 'removed' | 'modified' | 'status-changed';
  ruleId: string;
  rule?: SopRule;
  previousStatus?: RuleLifecycleStatus;
  timestamp: Date;
}

interface EvaluateActiveContext {
  rule: SopRule;
  now: number;
  day: number;
  downgraded: string[];
  deprecated: string[];
}

export class SopRegistry {
  private rules = new Map<string, SopRule>();
  private eventBus?: EventBus;

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus;
  }

  // ─── CRUD ──────────────────────────────────────────────────

  register(rule: SopRule): void {
    if (this.rules.has(rule.id)) {
      throw new Error(`SOP rule already registered: ${rule.id}`);
    }
    this.rules.set(rule.id, { ...rule });
    this.emitChange({ type: 'added', ruleId: rule.id, rule, timestamp: new Date() });
  }

  get(id: string): SopRule | undefined {
    return this.rules.get(id);
  }

  getAll(): SopRule[] {
    return [...this.rules.values()];
  }

  update(id: string, partial: Partial<SopRule>): SopRule {
    const existing = this.rules.get(id);
    if (!existing) {
      throw new Error(`SOP rule not found: ${id}`);
    }

    const previousStatus = existing.status;
    const updated: SopRule = { ...existing, ...partial, updatedAt: new Date() };
    this.rules.set(id, updated);

    if (partial.status && partial.status !== previousStatus) {
      this.emitChange({
        type: 'status-changed',
        ruleId: id,
        rule: updated,
        previousStatus,
        timestamp: new Date(),
      });
    } else {
      this.emitChange({ type: 'modified', ruleId: id, rule: updated, timestamp: new Date() });
    }

    return updated;
  }

  remove(id: string): boolean {
    const existed = this.rules.delete(id);
    if (existed) {
      this.emitChange({ type: 'removed', ruleId: id, timestamp: new Date() });
    }
    return existed;
  }

  // ─── 查询 ──────────────────────────────────────────────────

  query(filter: SopRuleFilter): SopRule[] {
    let results = this.getAll();

    if (filter.domain) {
      results = results.filter((r) => r.domain === filter.domain);
    }
    if (filter.action) {
      results = results.filter((r) => r.action === filter.action);
    }
    if (filter.source) {
      results = results.filter((r) => r.source === filter.source);
    }
    if (filter.status) {
      results = results.filter((r) => r.status === filter.status);
    }
    if (filter.severity) {
      results = results.filter((r) => r.severity === filter.severity);
    }
    if (filter.tags && filter.tags.length > 0) {
      results = results.filter((r) => filter.tags!.some((t) => r.tags.includes(t)));
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      results = results.filter(
        (r) =>
          r.id.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q),
      );
    }

    return results;
  }

  getByDomain(domain: GovernanceDomain): SopRule[] {
    return this.getAll().filter((r) => r.domain === domain);
  }

  getByAction(action: ActionType): SopRule[] {
    return this.getAll().filter((r) => r.action === action);
  }

  getActive(): SopRule[] {
    return this.getAll().filter((r) => r.status === 'active');
  }

  // ─── 能力声明查询 ────────────────────────────────────────

  /**
   * 聚合所有已注册规则的 serves 声明（语言/形态/架构去重合并）。
   * 空注册表或全部未声明时返回空对象。
   */
  getAllServes(): RuleServes {
    return this.mergeServes(this.getAll());
  }

  /**
   * 按治理域聚合 serves 声明。
   * 该域无规则声明 serves 时返回空对象。
   */
  getServes(domain: GovernanceDomain): RuleServes {
    return this.mergeServes(this.getByDomain(domain));
  }

  private mergeServes(rules: SopRule[]): RuleServes {
    const merged: RuleServes = {};
    for (const rule of rules) {
      if (!rule.serves) continue;
      for (const key of ['languages', 'productForms', 'architectures'] as const) {
        const values = rule.serves[key];
        if (values) {
          merged[key] = [...new Set([...(merged[key] ?? []), ...values])];
        }
      }
    }
    return merged;
  }

  // ─── 统计 ──────────────────────────────────────────────────

  getStats(): SopRuleStats {
    const all = this.getAll();
    const byDomain = {} as Record<GovernanceDomain, number>;
    const byAction = {} as Record<ActionType, number>;
    const byStatus = {} as Record<RuleLifecycleStatus, number>;
    const bySeverity: Record<string, number> = {};

    for (const rule of all) {
      byDomain[rule.domain] = (byDomain[rule.domain] ?? 0) + 1;
      byAction[rule.action] = (byAction[rule.action] ?? 0) + 1;
      byStatus[rule.status] = (byStatus[rule.status] ?? 0) + 1;
      bySeverity[rule.severity] = (bySeverity[rule.severity] ?? 0) + 1;
    }

    return {
      totalRules: all.length,
      byDomain,
      byAction,
      byStatus,
      bySeverity,
    };
  }

  // ─── 生命周期管理 ─────────────────────────────────────────

  /**
   * 自动升降级：
   * - 误报率 > 10% → active → trial
   * - 误报率 < 1% 且使用 > 30 天 → trial → active
   * - 连续 90 天未使用 → active → deprecated
   */
  evaluateLifecycle(): { upgraded: string[]; downgraded: string[]; deprecated: string[] } {
    const upgraded: string[] = [];
    const downgraded: string[] = [];
    const deprecated: string[] = [];
    const now = Date.now();
    const DAY = 86_400_000;

    for (const rule of this.getAll()) {
      this.evaluateActive({ rule, now, day: DAY, downgraded, deprecated });
      this.evaluateTrial(rule, now, DAY, upgraded);
    }

    return { upgraded, downgraded, deprecated };
  }

  private evaluateActive({ rule, now, day, downgraded, deprecated }: EvaluateActiveContext): void {
    if (rule.status !== 'active') return;
    const totalFeedbacks = rule.truePositiveCount + rule.falsePositiveCount;
    if (totalFeedbacks > 0) {
      const falsePositiveRate = rule.falsePositiveCount / totalFeedbacks;
      if (falsePositiveRate > 0.1) {
        this.update(rule.id, { status: 'trial' });
        downgraded.push(rule.id);
        return;
      }
    }
    if (rule.lastUsedAt && now - rule.lastUsedAt.getTime() > 90 * day) {
      this.update(rule.id, { status: 'deprecated' });
      deprecated.push(rule.id);
    }
  }

  private evaluateTrial(rule: SopRule, now: number, day: number, upgraded: string[]): void {
    if (rule.status !== 'trial') return;
    const totalFeedbacks = rule.truePositiveCount + rule.falsePositiveCount;
    if (totalFeedbacks > 0) {
      const falsePositiveRate = rule.falsePositiveCount / totalFeedbacks;
      if (falsePositiveRate < 0.01 && rule.createdAt.getTime() < now - 30 * day) {
        this.update(rule.id, { status: 'active' });
        upgraded.push(rule.id);
      }
    }
  }

  // ─── 批量操作 ──────────────────────────────────────────────

  loadAll(rules: SopRule[]): void {
    this.rules.clear();
    for (const rule of rules) {
      this.rules.set(rule.id, { ...rule });
    }
  }

  clear(): void {
    this.rules.clear();
  }

  count(): number {
    return this.rules.size;
  }

  // ─── 事件 ──────────────────────────────────────────────────

  private emitChange(event: RuleChangeEvent): void {
    if (this.eventBus) {
      this.eventBus.emit('sop:rule-changed', event).catch(() => {});
    }
  }
}

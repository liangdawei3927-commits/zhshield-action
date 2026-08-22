import type {
  SopRule,
  SopRuleFilter,
  GovernanceDomain,
  ActionType,
  RuleLifecycleStatus,
} from './sop-types';

// ─── 倒排索引：字段值 → 规则 id 集合（查询 O(1) 定位，避免全表扫描）
export class RuleIndex {
  private domainIndex = new Map<GovernanceDomain, Set<string>>();
  private actionIndex = new Map<ActionType, Set<string>>();
  private sourceIndex = new Map<string, Set<string>>();
  private statusIndex = new Map<RuleLifecycleStatus, Set<string>>();
  private severityIndex = new Map<string, Set<string>>();
  private tagsIndex = new Map<string, Set<string>>();

  add(rule: SopRule): void {
    this.insert(this.domainIndex, rule.domain, rule.id);
    this.insert(this.actionIndex, rule.action, rule.id);
    this.insert(this.sourceIndex, rule.source, rule.id);
    this.insert(this.statusIndex, rule.status, rule.id);
    this.insert(this.severityIndex, rule.severity, rule.id);
    for (const tag of rule.tags) {
      this.insert(this.tagsIndex, tag, rule.id);
    }
  }

  remove(rule: SopRule): void {
    this.drop(this.domainIndex, rule.domain, rule.id);
    this.drop(this.actionIndex, rule.action, rule.id);
    this.drop(this.sourceIndex, rule.source, rule.id);
    this.drop(this.statusIndex, rule.status, rule.id);
    this.drop(this.severityIndex, rule.severity, rule.id);
    for (const tag of rule.tags) {
      this.drop(this.tagsIndex, tag, rule.id);
    }
  }

  clear(): void {
    this.domainIndex.clear();
    this.actionIndex.clear();
    this.sourceIndex.clear();
    this.statusIndex.clear();
    this.severityIndex.clear();
    this.tagsIndex.clear();
  }

  byDomain(domain: GovernanceDomain): Set<string> | undefined {
    return this.domainIndex.get(domain);
  }

  byAction(action: ActionType): Set<string> | undefined {
    return this.actionIndex.get(action);
  }

  byStatus(status: RuleLifecycleStatus): Set<string> | undefined {
    return this.statusIndex.get(status);
  }

  /**
   * 按 filter 的索引字段求候选 id 交集。
   * 返回 null 表示没有任何索引字段命中（调用方应回退为全量扫描），
   * 返回空集合表示命中字段但无一匹配。
   */
  candidates(filter: SopRuleFilter): Set<string> | null {
    let candidateIds: Set<string> | null = null;

    if (filter.domain) {
      candidateIds = this.intersect(candidateIds, this.byDomain(filter.domain));
    }
    if (filter.action) {
      candidateIds = this.intersect(candidateIds, this.byAction(filter.action));
    }
    if (filter.source) {
      candidateIds = this.intersect(candidateIds, this.sourceIndex.get(filter.source));
    }
    if (filter.status) {
      candidateIds = this.intersect(candidateIds, this.byStatus(filter.status));
    }
    if (filter.severity) {
      candidateIds = this.intersect(candidateIds, this.severityIndex.get(filter.severity));
    }
    if (filter.tags && filter.tags.length > 0) {
      const tagMatches = new Set<string>();
      for (const tag of filter.tags) {
        for (const id of this.tagsIndex.get(tag) ?? []) tagMatches.add(id);
      }
      candidateIds = this.intersect(candidateIds, tagMatches);
    }

    return candidateIds;
  }

  private insert<K>(index: Map<K, Set<string>>, key: K, id: string): void {
    const bucket = index.get(key);
    if (bucket) {
      bucket.add(id);
    } else {
      index.set(key, new Set([id]));
    }
  }

  private drop<K>(index: Map<K, Set<string>>, key: K, id: string): void {
    const bucket = index.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (bucket.size === 0) index.delete(key);
  }

  private intersect(current: Set<string> | null, bucket: Set<string> | undefined): Set<string> {
    if (!bucket || bucket.size === 0) return new Set();
    if (current === null) return new Set(bucket);
    const [small, large] = current.size <= bucket.size ? [current, bucket] : [bucket, current];
    const out = new Set<string>();
    for (const id of small) {
      if (large.has(id)) out.add(id);
    }
    return out;
  }
}

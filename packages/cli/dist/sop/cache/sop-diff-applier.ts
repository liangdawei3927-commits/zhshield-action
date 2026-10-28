import type { SopRule, SopDiff } from '../_meta/sop-types';
import type { SopRegistry } from '../_meta/sop-registry';
import type { SopConflictPolicy } from './sop-conflict-policy';
import type { SopRuleAdmission } from './sop-rule-admission';

/** 变更应用器依赖：registry / admission / conflictPolicy 必需，persist 为落盘回调 */
export interface SopDiffApplierOptions {
  registry: SopRegistry;
  admission: SopRuleAdmission;
  conflictPolicy: SopConflictPolicy;
  /** 持久化回调（通常是 `sqliteStore.persist` 的薄封装） */
  persist: (rules: SopRule[]) => void;
}

/**
 * 云端规则变更应用器 — 把「远程变更写进本地」这件事从协调器里独立出来。
 *
 * 抽出的动因有两个：
 *  1. 所有写入路径必须经过同一个准入关口（`SopRuleAdmission`），散在协调器各处
 *     极易漏掉一条 —— 事实上原实现的四条路径全都漏了；
 *  2. 协调器只应负责「版本对比 + 调度 + 流程编排」，写库细节混在一起会让
 *     `large-class` 门禁长期红着（该类改动前已 357 行）。
 */
export class SopDiffApplier {
  private registry: SopRegistry;
  private admission: SopRuleAdmission;
  private conflictPolicy: SopConflictPolicy;
  private persist: (rules: SopRule[]) => void;

  constructor(options: SopDiffApplierOptions) {
    this.registry = options.registry;
    this.admission = options.admission;
    this.conflictPolicy = options.conflictPolicy;
    this.persist = options.persist;
  }

  /** 增量变更：先删后 upsert（modified 与 added 语义均为 upsert，合并处理避免两套分支） */
  applyChanges(diff: SopDiff): void {
    for (const ruleId of diff.removed) {
      this.registry.remove(ruleId);
    }
    this.upsert([...diff.modified, ...diff.added]);
  }

  /** 逐条 upsert（已存在则更新）；返回实际被接纳的规则，供调用方持久化干净数据 */
  upsert(rules: readonly SopRule[]): SopRule[] {
    const accepted: SopRule[] = [];
    for (const rule of rules) {
      const effective = this.conflictPolicy.resolveIncoming(rule);
      const admitted = this.admission.admit(effective);
      if (!admitted) continue;
      if (this.registry.has(admitted.id)) {
        this.registry.update(admitted.id, admitted);
      } else {
        this.registry.register(admitted);
      }
      accepted.push(admitted);
    }
    return accepted;
  }

  /** 全量替换：最危险的入口（一条坏规则会连带覆盖本地可用规则），先校验再落盘 */
  applyFull(rules: readonly SopRule[]): SopRule[] {
    const admitted = this.admission.admitAll(rules);
    this.registry.loadAll(admitted);
    this.persist(admitted);
    return admitted;
  }

  /** 缓存恢复：只装载、不写回（避免刚读出来又覆盖磁盘） */
  restore(rules: readonly SopRule[]): SopRule[] {
    const admitted = this.admission.admitAll(rules);
    if (admitted.length > 0) this.registry.loadAll(admitted);
    return admitted;
  }

  /** 持久化当前 registry 全量（增量应用后调用） */
  persistRegistry(): void {
    this.persist(this.registry.getAll());
  }
}

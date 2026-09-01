import type { SopRule } from './sop-types';
import { SopRegistry } from './sop-registry';

/**
 * SOP 规则注册器 — 将规则批量写入注册中心（新增 / 更新 / 全量替换）
 *
 * 职责：
 * 1. 批量注册：replaceAll 时全量替换，否则按 id 存在性走 update/register
 * 2. 知识库加载：已存在则更新，否则注册
 */
export class SopRuleRegistrar {
  private registry: SopRegistry;

  constructor(registry: SopRegistry) {
    this.registry = registry;
  }

  registerAll(rules: SopRule[], replaceAll: boolean): void {
    if (replaceAll) {
      this.registry.loadAll(rules);
      return;
    }
    for (const rule of rules) {
      if (this.registry.has(rule.id)) {
        this.registry.update(rule.id, rule);
      } else {
        this.registry.register(rule);
      }
    }
  }

  /** 从知识库加载：已存在则更新，否则注册 */
  loadFromKnowledgeBase(rules: SopRule[]): void {
    for (const rule of rules) {
      if (this.registry.has(rule.id)) {
        this.registry.update(rule.id, rule);
      } else {
        this.registry.register(rule);
      }
    }
  }
}

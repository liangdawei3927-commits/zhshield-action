import type { SopRule } from '../../sop/_meta/sop-types';

/** 构造测试规则：未覆盖字段取默认值 */
export function makeRule(overrides: Partial<SopRule> & { id: string }): SopRule {
  return {
    id: overrides.id,
    name: overrides.name ?? 'test-rule',
    domain: overrides.domain ?? 'guard',
    action: overrides.action ?? 'scan',
    source: overrides.source ?? 'official',
    description: overrides.description ?? '',
    status: overrides.status ?? 'active',
    executionMode: overrides.executionMode ?? 'sync',
    severity: overrides.severity ?? 'medium',
    ...(overrides.accumulationPolicy !== undefined
      ? { accumulationPolicy: overrides.accumulationPolicy }
      : {}),
    ...(overrides.blockingThreshold !== undefined
      ? { blockingThreshold: overrides.blockingThreshold }
      : {}),
    applicableEngines: overrides.applicableEngines ?? ['guard'],
    content: overrides.content ?? {},
    serves: overrides.serves,
    tags: overrides.tags ?? [],
    falsePositiveCount: overrides.falsePositiveCount ?? 0,
    truePositiveCount: overrides.truePositiveCount ?? 0,
    lastUsedAt: overrides.lastUsedAt,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

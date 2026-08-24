import { describe, it, expect } from 'vitest';

import { resolveSeverity, severityRank, SEVERITY_RANK } from '../sop/_meta/adaptive-severity';
import { makeRule } from './helpers/rule-factory';
import type { SopRule } from '../sop/_meta/sop-types';

describe('resolveSeverity — F1-3 纯函数', () => {
  it('无 accumulationPolicy 且无 ctx → 静态 severity 原样返回', () => {
    const rule = makeRule({ id: 'r1', severity: 'medium' });

    expect(resolveSeverity(rule)).toBe('medium');
    expect(resolveSeverity(rule, {})).toBe('medium');
  });

  it('无 accumulationPolicy 时完全忽略 consecutiveFailures（再大也不升级）', () => {
    const rule = makeRule({ id: 'r2', severity: 'low' });

    expect(resolveSeverity(rule, { consecutiveFailures: 999 })).toBe('low');
  });

  it('consecutiveFailures < threshold → 不升级；== threshold → 升到 escalateTo', () => {
    const rule = makeRule({
      id: 'r3',
      severity: 'medium',
      accumulationPolicy: { threshold: 2, escalateTo: 'high' },
    });

    expect(resolveSeverity(rule, { consecutiveFailures: 1 })).toBe('medium');
    expect(resolveSeverity(rule, { consecutiveFailures: 2 })).toBe('high');
    expect(resolveSeverity(rule, { consecutiveFailures: 10 })).toBe('high');
  });

  it('threshold 缺省时按 3 判定', () => {
    const rule = makeRule({
      id: 'r4',
      severity: 'medium',
      accumulationPolicy: { escalateTo: 'critical' },
    });

    expect(resolveSeverity(rule, { consecutiveFailures: 2 })).toBe('medium');
    expect(resolveSeverity(rule, { consecutiveFailures: 3 })).toBe('critical');
  });

  it('escalateTo 秩不高于静态 severity → 安全空操作（绕过加载器的手工输入）', () => {
    const lower = makeRule({
      id: 'r5',
      severity: 'high',
      accumulationPolicy: { threshold: 1, escalateTo: 'low' },
    });
    const equal = makeRule({
      id: 'r6',
      severity: 'high',
      accumulationPolicy: { threshold: 1, escalateTo: 'high' },
    });

    expect(resolveSeverity(lower, { consecutiveFailures: 100 })).toBe('high');
    expect(resolveSeverity(equal, { consecutiveFailures: 100 })).toBe('high');
  });

  it('healthBaseline < 60 → 沿固定顺序恰好上移一档（medium→error）', () => {
    const rule = makeRule({ id: 'r7', severity: 'medium' });

    expect(resolveSeverity(rule, { healthBaseline: 59 })).toBe('error');
    expect(resolveSeverity(rule, { healthBaseline: 0 })).toBe('error');
  });

  it('healthBaseline >= 60 或缺省 → 不升档', () => {
    const rule = makeRule({ id: 'r8', severity: 'medium' });

    expect(resolveSeverity(rule, { healthBaseline: 60 })).toBe('medium');
    expect(resolveSeverity(rule, { healthBaseline: 100 })).toBe('medium');
  });

  it('策略升级与基线升档叠加，封顶 critical', () => {
    const rule = makeRule({
      id: 'r9',
      severity: 'medium',
      accumulationPolicy: { threshold: 1, escalateTo: 'high' },
    });

    // medium --policy--> high --baseline--> critical
    expect(resolveSeverity(rule, { consecutiveFailures: 1, healthBaseline: 30 })).toBe('critical');

    const atCap = makeRule({
      id: 'r10',
      severity: 'critical',
      accumulationPolicy: { threshold: 1, escalateTo: 'critical' },
    });
    expect(resolveSeverity(atCap, { consecutiveFailures: 5, healthBaseline: 10 })).toBe('critical');
  });

  it('遗留越界 severity 值在基线 <60 下保持不动（不跳到 info）', () => {
    const rule = makeRule({ id: 'r11', severity: 'medium' });
    // 模拟存量数据经反序列化边界带入联合之外的 severity 值
    const legacy: SopRule = JSON.parse(JSON.stringify({ ...rule, severity: 'warning' }));

    expect(resolveSeverity(legacy, { healthBaseline: 10 })).toBe('warning');
  });

  it('纯函数：不修改入参 rule', () => {
    const rule = makeRule({
      id: 'r12',
      severity: 'medium',
      accumulationPolicy: { threshold: 1, escalateTo: 'critical' },
    });
    const snapshot = { ...rule };

    resolveSeverity(rule, { consecutiveFailures: 9, healthBaseline: 1 });

    expect(rule).toEqual(snapshot);
    expect(rule.severity).toBe('medium');
  });
});

describe('severityRank / SEVERITY_RANK — 秩序表单一事实源', () => {
  it('固定升序 info=0 … critical=5，未知值 -1', () => {
    expect(severityRank('info')).toBe(0);
    expect(severityRank('low')).toBe(1);
    expect(severityRank('medium')).toBe(2);
    expect(severityRank('error')).toBe(3);
    expect(severityRank('high')).toBe(4);
    expect(severityRank('critical')).toBe(5);
    expect(severityRank('warning')).toBe(-1);
  });

  it('SEVERITY_RANK 覆盖 Severity 联合的全部成员', () => {
    const members: readonly string[] = ['critical', 'high', 'medium', 'low', 'info', 'error'];
    for (const m of members) {
      expect(SEVERITY_RANK.has(m)).toBe(true);
    }
  });
});

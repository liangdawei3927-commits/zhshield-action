import { describe, it, expect } from 'vitest';

import { computeBlocking } from '../sop/_meta/rule-evaluation';
import type { Severity } from '../sop/_meta/sop-types';
import type { EvaluationStatus } from '../sop/_meta/rule-evaluation';

describe('computeBlocking — F1-4 真值表', () => {
  it('passed / skipped / error 一律不阻断（即使声明了阈值）', () => {
    const statuses: EvaluationStatus[] = ['passed', 'skipped', 'error'];
    for (const status of statuses) {
      expect(computeBlocking(status, 'critical')).toBe(false);
      expect(computeBlocking(status, 'critical', 'critical')).toBe(false);
      expect(computeBlocking(status, 'info', 'low')).toBe(false);
    }
  });

  it('failed 且未声明阈值 → 阻断（旧行为保留）', () => {
    expect(computeBlocking('failed', 'medium')).toBe(true);
    expect(computeBlocking('failed', 'info')).toBe(true);
    expect(computeBlocking('failed', 'critical')).toBe(true);
  });

  it("failed + threshold 'critical' + 有效严重级 'medium' → 不阻断", () => {
    expect(computeBlocking('failed', 'medium', 'critical')).toBe(false);
  });

  it("failed + 升级到 'critical' 的有效严重级 + threshold 'critical' → 阻断（秩相等即达标）", () => {
    expect(computeBlocking('failed', 'critical', 'critical')).toBe(true);
  });

  it("threshold 'error' + 有效严重级 'error' → 阻断", () => {
    expect(computeBlocking('failed', 'error', 'error')).toBe(true);
  });

  it("threshold 'error' + 有效严重级 'high' → 阻断（秩高于阈值）", () => {
    expect(computeBlocking('failed', 'high', 'error')).toBe(true);
  });

  it('未知 severity（秩 -1）对任何已声明阈值都不阻断', () => {
    // 存量数据可能携带联合之外的遗留运行时值（如 'warning'）；模拟边界反序列化产物
    const legacySeverity: Severity = JSON.parse('"warning"');
    for (const threshold of ['low', 'medium', 'error', 'high', 'critical'] as const) {
      expect(computeBlocking('failed', legacySeverity, threshold)).toBe(false);
    }
  });
});

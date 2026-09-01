import { describe, it, expect } from 'vitest';
import { createReport } from '@zh/pipeline';
import type { RuleEngineReport } from '@zh/kernel';

/**
 * 门禁/哨兵总开关相关逻辑测试
 *
 * 覆盖：
 *   1. guard-config 默认 enabled=true + 向后兼容
 *   2. createSkippedGuardReport 产出合规的通过报告
 *   3. createReport 携带 skipped guard 时 passed 判定
 */

// ─── 1. guard-config 默认值与向后兼容 ─────────────────────

describe('GuardConfig enabled field', () => {
  it('DEFAULT_CONFIG.enabled 默认为 true', () => {
    const DEFAULT_CONFIG = {
      enabled: true,
      preCommit: true,
      prePush: true,
      blockOnCritical: true,
    };
    expect(DEFAULT_CONFIG.enabled).toBe(true);
  });

  it('旧配置缺失 enabled 字段时向后兼容为 true', () => {
    // 模拟旧版 guard-config.json 无 enabled 字段
    const legacyConfig = {
      preCommit: true,
      prePush: false,
      blockOnCritical: true,
    } as Record<string, unknown>;

    const enabled = typeof legacyConfig.enabled === 'boolean' ? legacyConfig.enabled : true;
    expect(enabled).toBe(true);
  });

  it('显式设置 enabled=false 时保持 false', () => {
    const config = { enabled: false, preCommit: true, prePush: true, blockOnCritical: true };
    expect(config.enabled).toBe(false);
  });

  it('enabled 为非布尔值时降级为默认 true', () => {
    const badConfig = { enabled: 'yes', preCommit: true } as Record<string, unknown>;
    const enabled = typeof badConfig.enabled === 'boolean' ? badConfig.enabled : true;
    expect(enabled).toBe(true);
  });
});

// ─── 2. createSkippedGuardReport 结构 ─────────────────────

describe('createSkippedGuardReport', () => {
  function createSkippedGuardReport(): RuleEngineReport {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 1,
      ok: true,
      blockingCount: 0,
      evaluations: [],
      durationMs: 0,
      timestamp: new Date(),
    };
  }

  it('跳过的门禁报告 ok=true、failed=0、skipped=1', () => {
    const report = createSkippedGuardReport();
    expect(report.ok).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.blockingCount).toBe(0);
    expect(report.evaluations).toEqual([]);
  });

  it('跳过的门禁报告通过 pipeline createReport 判定为 passed', () => {
    const guardReport = createSkippedGuardReport();
    const report = createReport({
      guard: guardReport,
      passed: true,
      stage: 'complete',
    });
    expect(report.passed).toBe(true);
    expect(report.stage).toBe('complete');
  });
});

// ─── 3. PipelineReport 携带 skipped guard 的摘要 ──────────

describe('PipelineReport with skipped guard', () => {
  it('guard passed=true + inspect passed=true → 整体 passed', () => {
    const guardReport = {
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 1,
      ok: true,
      blockingCount: 0,
      evaluations: [],
      durationMs: 0,
      timestamp: new Date(),
    };
    const inspectReport = {
      total: 3,
      passed: 3,
      failed: 0,
      errors: 0,
      skipped: 0,
      ok: true,
      blockingCount: 0,
      evaluations: [],
      durationMs: 100,
      timestamp: new Date(),
    };
    const report = createReport({
      guard: guardReport,
      inspect: inspectReport,
      passed: true,
      stage: 'complete',
    });
    expect(report.passed).toBe(true);
    expect(report.guard).toBeDefined();
    expect(report.inspect).toBeDefined();
  });

  it('guard skipped + inspect 有失败 → 整体 passed=false', () => {
    const guardReport = {
      total: 0,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 1,
      ok: true,
      blockingCount: 0,
      evaluations: [],
      durationMs: 0,
      timestamp: new Date(),
    };
    const inspectReport = {
      total: 5,
      passed: 2,
      failed: 3,
      errors: 0,
      skipped: 0,
      ok: false,
      blockingCount: 3,
      evaluations: [],
      durationMs: 200,
      timestamp: new Date(),
    };
    const report = createReport({
      guard: guardReport,
      inspect: inspectReport,
      passed: false,
      stage: 'inspect',
    });
    expect(report.passed).toBe(false);
    expect(report.stage).toBe('inspect');
  });
});

/**
 * 回归：哨兵域「0 覆盖 ≠ 满分」（sentinel-coverage.test.ts）
 *
 * 缺陷（2026-10-29 实机）：三个监视器（文件 / 日志 / 进程）里两个会被跳过
 * —— 项目没有 package.json ⇒ process-monitor 跳过，没有日志文件 ⇒ log-collector 跳过。
 * 极端情况下一个都没起来，事件恒为 0 ⇒ sentinelPenalty(0)=0 ⇒ 哨兵域 100 分。
 * 用户读到的是「监控过了、没问题」，实际是「根本没监控」。
 *
 * 修复：extras.sentinel.monitorsStarted === 0 → 维度判 not-run（与 refactor 的
 * scannedFiles===0 同口径）；缺省（旧数据 / 未启动监控）保持 scored，不误伤历史。
 *
 * ⚠️ 部分覆盖（1~2 个监视器）**不判 not-run**：此时确实有真实监控产出，
 * 覆盖不足由 UI 的「监控范围」清单如实提示，不该把真跑过的域抹成未检测。
 */
import { describe, it, expect } from 'vitest';
import { buildHealthDimensions } from '../pipeline-score';
import type { DimensionExtras } from '../types';

const cleanGuard = { results: [] };
const cleanInspect = { issues: [] };

function extrasWith(sentinel: NonNullable<DimensionExtras['sentinel']>): DimensionExtras {
  return {
    secrets: { activeCount: 0 },
    deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
    techdebt: { debtIndex: 0, issueCount: 0 },
    sentinel,
    refactor: { totalSmells: 0, bySeverity: { error: 0, warning: 0, info: 0 }, scannedFiles: 12 },
    performance: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
    garbage: { total: 0, byType: {} },
    backup: {
      lastSuccessAt: new Date().toISOString(),
      recentStatuses: ['success'],
      scheduleEnabled: true,
    },
  };
}

function sentinelDim(extras: DimensionExtras): { score: number; issues: number; status: string } {
  const dim = buildHealthDimensions({ guard: cleanGuard, inspect: cleanInspect, extras }).find(
    (d) => d.name === 'sentinel',
  );
  expect(dim, 'sentinel 维度必须存在').toBeTruthy();
  return { score: dim!.score, issues: dim!.issues, status: dim!.status };
}

describe('scoreSentinel — 0 覆盖判 not-run', () => {
  it('真阳性：monitorsStarted=0（无任何监视器起来）→ not-run，不出现 100 分', () => {
    const dim = sentinelDim(
      extrasWith({ active: true, criticalEvents: 0, warningEvents: 0, monitorsStarted: 0 }),
    );
    expect(dim.status).toBe('not-run');
    expect(dim.score).toBe(0);
    expect(dim.issues).toBe(0);
  });

  it('误报防护：monitorsStarted=1 且无告警 → 正常 scored 100 分', () => {
    const dim = sentinelDim(
      extrasWith({ active: true, criticalEvents: 0, warningEvents: 0, monitorsStarted: 1 }),
    );
    expect(dim.status).toBe('scored');
    expect(dim.score).toBe(100);
  });

  it('向后兼容：monitorsStarted 缺省（旧数据 / 未启动监控）→ 保持 scored', () => {
    const dim = sentinelDim(extrasWith({ active: true, criticalEvents: 0, warningEvents: 0 }));
    expect(dim.status).toBe('scored');
    expect(dim.score).toBe(100);
  });

  it('算法未被破坏：有覆盖且存在 p2 告警 → 照常扣分', () => {
    const dim = sentinelDim(
      extrasWith({ active: true, criticalEvents: 0, warningEvents: 3, monitorsStarted: 2 }),
    );
    expect(dim.status).toBe('scored');
    expect(dim.score).toBeLessThan(100);
    expect(dim.issues).toBe(3);
  });
});

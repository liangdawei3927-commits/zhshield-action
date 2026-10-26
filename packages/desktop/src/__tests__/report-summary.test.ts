import { describe, expect, it } from 'vitest';
import {
  hasAnyExtraResult,
  toGuardChecks,
  toInspectIssues,
  type GuardReportCheck,
} from '../../electron/report-summary';
import type { DiagnosticEntry } from '../../electron/zh-diagnostics';

/**
 * 报告中心「只读汇总」输入映射守卫（T10）。
 *
 * 汇总路径复用 pipeline 的评分算法，因此「落盘结果 → 算法输入」的映射必须与
 * pipeline 的粒度一致，否则同一项目在两条路径上会得到不同分数、历史趋势断裂。
 * 本文件锁定的就是这个等价性。
 */

function check(partial: Partial<GuardReportCheck>): GuardReportCheck {
  return {
    checkId: 'check',
    adapter: 'adapter',
    status: 'passed',
    severity: 'info',
    blocking: false,
    message: '',
    ...partial,
  };
}

function entry(partial: Partial<DiagnosticEntry>): DiagnosticEntry {
  return {
    ruleId: 'rule',
    severity: 'warning',
    category: 'quality',
    message: 'msg',
    file: 'src/a.ts',
    autoFixable: false,
    source: 'inspect',
    fingerprint: 'fp',
    ...partial,
  };
}

/** 与 @zh/scoring 的 guardPenalty 同式复算，用于验证粒度等价（不是重实现产品算法） */
function guardPenalty(checks: ReturnType<typeof toGuardChecks>): number {
  return checks.reduce((sum, c) => {
    if (c.status === 'failed' || c.status === 'error' || c.blocking) return sum + 8;
    if (c.status === 'warning') return sum + 4;
    return sum;
  }, 0);
}

describe('guard 报告记录 → gate 维度输入', () => {
  it('原样透传 severity / status / blocking', () => {
    expect(
      toGuardChecks([
        check({ status: 'passed', severity: 'info', blocking: false }),
        check({ status: 'failed', severity: 'error', blocking: true }),
      ]),
    ).toEqual([
      { severity: 'info', status: 'passed', blocking: false },
      { severity: 'error', status: 'failed', blocking: true },
    ]);
  });

  it('粒度等价：通过项不计罚，失败 / 阻塞记 8、warning 记 4', () => {
    const checks = toGuardChecks([
      check({ status: 'passed' }),
      check({ status: 'failed' }),
      check({ status: 'warning' }),
      check({ status: 'error', blocking: true }),
    ]);
    // passed 0 + failed 8 + warning 4 + error 8 = 20
    expect(guardPenalty(checks)).toBe(20);
  });

  it('空记录 → 空数组（不抛错，由调用方按 null 语义处理）', () => {
    expect(toGuardChecks([])).toEqual([]);
  });
});

describe('inspect 快照 → quality/security/dependencies 维度输入', () => {
  it('只保留维度映射所需字段（severity / category / ruleId——ruleId 供 S1 单规则扣分封顶聚合）', () => {
    expect(
      toInspectIssues([
        entry({ severity: 'error', category: 'security' }),
        entry({ severity: 'info', category: 'architecture' }),
      ]),
    ).toEqual([
      { severity: 'error', category: 'security', ruleId: 'rule' },
      { severity: 'info', category: 'architecture', ruleId: 'rule' },
    ]);
  });
});

describe('扩展域结果判定', () => {
  it('全空（含字段缺省 undefined）判为「无结果」', () => {
    expect(hasAnyExtraResult({})).toBe(false);
    expect(hasAnyExtraResult({ secrets: null, deps: null, techdebt: null })).toBe(false);
  });

  it('任一域有值即判为「有结果」——含 0 值（0 表示跑过且无问题，不是没跑）', () => {
    expect(hasAnyExtraResult({ secrets: { activeCount: 0 } })).toBe(true);
    expect(hasAnyExtraResult({ deps: null, techdebt: { debtIndex: 0, issueCount: 0 } })).toBe(true);
  });
});

/**
 * toolError 豁免（2026-10-26）：工具执行失败不是代码问题。
 * 打包版 4 条工具报错曾以 warning 档混入 quality 扣分（-16 × 密度稀释 ≈ -3.1），
 * 与 CLI 侧 degraded 护栏语义不一致。评分输入必须过滤，展示链路不丢信息。
 */
describe('toInspectIssues 的 toolError 豁免', () => {
  it('toolError 条目不进入评分输入', () => {
    const issues = toInspectIssues([
      entry({ ruleId: 'r-tool', severity: 'warning', toolError: true }),
      entry({ ruleId: 'r-real', severity: 'warning' }),
    ]);
    expect(issues.map((i) => i.ruleId)).toEqual(['r-real']);
  });

  it('无 toolError 标记的条目全部保留（向后兼容旧快照）', () => {
    const issues = toInspectIssues([entry({ ruleId: 'r-1' }), entry({ ruleId: 'r-2' })]);
    expect(issues).toHaveLength(2);
  });
});

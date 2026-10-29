import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createGateMetricResolver, readProjectCoveragePct } from '../gate-metrics';
import { evaluatePostScanGates } from '@zh/kernel';
import type { GateValue, SopRule } from '@zh/kernel';

/**
 * 扫描后门禁的取数层。
 *
 * 与前一轮 `rule-metrics.test.ts` 的分界：
 *   · 那边测「引擎内可算的指标」（复杂度，AST 遍历）；
 *   · 这边测「扫描结束后才存在的聚合值」（覆盖率报告 / 评分）。
 *
 * 守的仍是同一条铁律：**测不到就给不出，且必须说清为什么**。
 * 覆盖率声明 `scope: diff` 却只能读到全量时，代入全量就是用错口径下结论。
 */

describe('createGateMetricResolver', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'gate-metrics-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const writeCoverage = (body: string) => {
    mkdirSync(path.join(repoRoot, 'coverage'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'coverage', 'coverage-summary.json'), body, 'utf-8');
  };

  const rule = (content: Record<string, unknown>, id = 'guard.block.official.test-coverage') =>
    ({
      id,
      domain: 'guard',
      action: 'block',
      status: 'active',
      content,
    }) as unknown as SopRule;

  const coverageRule = (scope?: string) =>
    rule({ threshold: 80, unit: 'percent', ...(scope ? { scope } : {}) });

  describe('覆盖率', () => {
    it('GIVEN 存在 json-summary 报告且 scope 非 diff WHEN 取数 THEN 返回行覆盖率', () => {
      writeCoverage(JSON.stringify({ total: { lines: { pct: 85.5 } } }));

      const resolve = createGateMetricResolver(repoRoot);
      expect(resolve(coverageRule('project'))).toEqual({ actual: 85.5 });
    });

    it('GIVEN 报告里 pct 是字符串 WHEN 取数 THEN 不认（不当数字用）', () => {
      writeCoverage(JSON.stringify({ total: { lines: { pct: '85' } } }));

      const value = createGateMetricResolver(repoRoot)(coverageRule('project')) as {
        unavailableReason?: string;
      };
      expect(value.unavailableReason).toContain('未找到覆盖率报告');
    });

    it('GIVEN 规则声明 scope=diff WHEN 取数 THEN 不拿全量冒充（即使有报告）', () => {
      writeCoverage(JSON.stringify({ total: { lines: { pct: 92 } } }));

      const value = createGateMetricResolver(repoRoot)(coverageRule('diff')) as {
        unavailableReason?: string;
      };
      expect(value.unavailableReason).toContain('scope=diff');
      expect(value.unavailableReason).toContain('92');
    });

    it('GIVEN 报告文件损坏 WHEN 取数 THEN 按不可用处理而不是抛错', () => {
      writeCoverage('{ 这不是 JSON');

      expect(readProjectCoveragePct(repoRoot)).toBeUndefined();
      const value = createGateMetricResolver(repoRoot)(coverageRule('project')) as {
        unavailableReason?: string;
      };
      expect(value.unavailableReason).toContain('未找到覆盖率报告');
    });

    it('GIVEN 调用方直接给了覆盖率 WHEN 取数 THEN 用给定值，不去翻报告', () => {
      const resolve = createGateMetricResolver(repoRoot, { coveragePct: 63 });
      expect(resolve(coverageRule('project'))).toEqual({ actual: 63 });
    });
  });

  describe('评分型门禁', () => {
    it('GIVEN 未传入评分 WHEN 取数 THEN 说明「需在评分阶段判定」而非沉默', () => {
      const resolve = createGateMetricResolver(repoRoot);
      for (const id of [
        'guard.block.official.health-score',
        'inspect.score.official.quality-score',
      ]) {
        const value = resolve(rule({ threshold: 70, unit: 'score' }, id)) as {
          unavailableReason?: string;
        };
        expect(value.unavailableReason).toContain('聚合评分');
        expect(value.unavailableReason).toContain('评分阶段');
      }
    });

    it('GIVEN 调用方传入评分 WHEN 取数 THEN 直接可用（桌面端评分后调用即此路径）', () => {
      const resolve = createGateMetricResolver(repoRoot, { healthScore: 82, qualityScore: 91 });
      expect(resolve(rule({ threshold: 70, unit: 'score' }, 'guard.block.official.health-score')))
        .toEqual({ actual: 82 });
      expect(
        resolve(rule({ threshold: 90 }, 'inspect.score.official.quality-score')),
      ).toEqual({ actual: 91 });
    });
  });

  describe('端到端：取数 + 判定', () => {
    it('GIVEN 覆盖率 63% 与阈值 80 WHEN 走完整链路 THEN failed（而不是「未判定」）', () => {
      writeCoverage(JSON.stringify({ total: { lines: { pct: 63 } } }));
      const rules = [coverageRule('project')];
      const report = evaluatePostScanGates(rules, createGateMetricResolver(repoRoot));

      expect(report.items[0].status).toBe('failed');
      expect(report.ok).toBe(false);
    });

    it('GIVEN 覆盖率达标 WHEN 走完整链路 THEN passed', () => {
      writeCoverage(JSON.stringify({ total: { lines: { pct: 88 } } }));
      const report = evaluatePostScanGates(
        [coverageRule('project')],
        createGateMetricResolver(repoRoot),
      );

      expect(report.items[0].status).toBe('passed');
      expect(report.ok).toBe(true);
    });

    it('GIVEN 无覆盖率报告 WHEN 走完整链路 THEN undetermined（不算通过也不算失败）', () => {
      const resolver: (r: SopRule) => GateValue = createGateMetricResolver(repoRoot);
      const report = evaluatePostScanGates([coverageRule('project')], resolver);

      expect(report.items[0].status).toBe('undetermined');
      expect(report.ok).toBe(false);
      expect(report.complete).toBe(false);
    });
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';

import { readGateDeclaration } from '@zh/kernel';
import type { GateValue, SopRule } from '@zh/kernel';
import {
  DEFAULT_DIFF_COVERAGE_REPORTS,
  computeDiffCoverage,
  readChangedLines,
  readLineCoverage,
  resolveCoverageBase,
} from './gate-coverage-diff';

/**
 * 后置门禁的取数实现（扫描完成后才存在的数据）。
 *
 * 与 `rule-metrics.ts` 的分工——这条线必须分清，否则又会造出「两个地方都能取数」的双真源：
 *   · `rule-metrics.ts`：**引擎内**求值时可算的指标（复杂度，靠 AST 遍历）。
 *     引擎在扫描过程中调用它，一次扫描内缓存复用。
 *   · 本模块：**扫描结束后**才存在的聚合值（健康分 / 质量分 / 覆盖率）。
 *     只在 `evaluatePostScanGates` 里调用，也就是 gate 阶段。
 *
 * 取不到就返回 unavailableReason，**不拿旧分或全量值顶替**：
 * 覆盖率声明 `scope: diff` 而只能读到全量时，代入全量就是用错口径下结论。
 */

/** 默认覆盖率报告候选（相对项目根；istanbul / vitest 的 json-summary 标准产物） */
export const DEFAULT_COVERAGE_REPORTS: readonly string[] = ['coverage/coverage-summary.json'];

/**
 * 门禁取数入参。
 *
 * 这里没有质量分：云端 `inspect.score.official.quality-score` 定义的是
 * 「巡检结果 → 质量分」的映射（`threshold: 100` 配 `mapping.baseScore: 100` 是满分基准，
 * 不是通过线），已在 kernel 登记为 `MAPPING_RULES`，不参与门禁判定。见 post-scan-gate.ts。
 */
export interface GateMetricInputs {
  /** 健康分（0–100）。由评分阶段显式传入；不传则本入口判「未判定」 */
  healthScore?: number;
  /**
   * 直接给定**全量**覆盖率百分比，跳过读报告。
   * 只对 `scope: project` 生效 —— `scope: diff` 要的是改动行覆盖率，全量数替不了。
   */
  coveragePct?: number;
  /** 覆盖率报告候选路径（相对 repoRoot），按顺序取第一个存在的 */
  coverageReportPaths?: string[];
  /** diff 覆盖率基线（默认按 origin/main → origin/master → main → master 求 merge-base） */
  coverageBase?: string;
}

/**
 * 创建门禁取数器。
 *
 * @param repoRoot 项目根（读覆盖率报告用）
 * @param inputs   调用方已知的聚合值；缺项一律落「未判定 + 原因」
 */
export function createGateMetricResolver(
  repoRoot: string,
  inputs: GateMetricInputs = {},
): (rule: SopRule) => GateValue {
  const candidates = inputs.coverageReportPaths ?? DEFAULT_COVERAGE_REPORTS;
  return (rule) => {
    const decl = readGateDeclaration(rule);
    switch (decl.metric) {
      case 'coverage':
        return coverageValue(rule, repoRoot, candidates, inputs);
      case 'health-score':
        return scoreValue(
          '健康分',
          inputs.healthScore,
          '健康分是整轮扫描结束后由 @zh/scoring 聚合产出，当前入口（CLI/引擎）不计算聚合评分；' +
            '请在评分阶段（桌面端）判定，或由调用方显式传入 healthScore',
        );
      default:
        return { unavailableReason: `未登记的门禁指标口径（规则「${rule.id}」）` };
    }
  };
}

function coverageValue(
  rule: SopRule,
  repoRoot: string,
  candidates: readonly string[],
  inputs: GateMetricInputs,
): GateValue {
  const scope = readScopeValue(rule, 'scope');
  if (scope === 'diff') return diffCoverageValue(repoRoot, inputs);
  if (typeof inputs.coveragePct === 'number') return { actual: inputs.coveragePct };

  const pct = readProjectCoveragePct(repoRoot, candidates);
  if (pct === undefined) {
    return {
      unavailableReason:
        `未找到覆盖率报告（已查找: ${candidates.join(', ')}）。` +
        '需先运行带 json-summary reporter 的测试（如 vitest --coverage）',
    };
  }
  return { actual: pct };
}

/**
 * diff 覆盖率取数。任何一步拿不到就返回原因，**不退化成全量口径**：
 * 全量 85% 与新增代码 0% 覆盖是两个相反的结论，代入等于给用户一个错误的绿灯。
 */
function diffCoverageValue(repoRoot: string, inputs: GateMetricInputs): GateValue {
  const base = resolveCoverageBase(
    repoRoot,
    inputs.coverageBase ?? process.env.ZH_COVERAGE_BASE ?? undefined,
  );
  if ('reason' in base) return { unavailableReason: base.reason };

  const changed = readChangedLines(repoRoot, base.base);
  if (typeof changed === 'string') return { unavailableReason: changed };
  if (changed.size === 0) {
    return { actual: 100, note: `相对基线（${base.how}）无代码改动，视为达标` };
  }

  const coverage = readLineCoverage(repoRoot, inputs.coverageReportPaths);
  if (!coverage) {
    return {
      unavailableReason:
        `未找到含行级数据的覆盖率报告（已查找: ${(inputs.coverageReportPaths ?? DEFAULT_DIFF_COVERAGE_REPORTS).join(', ')}）。` +
        'coverage-summary.json 只有总数、没有行号，算不出 diff 覆盖率；' +
        '需启用 lcov 或 json reporter（vitest: coverage.reporter 加 "lcov"）',
    };
  }

  const result = computeDiffCoverage(changed, coverage);
  if ('reason' in result) return { unavailableReason: result.reason };
  const note =
    `${base.how}；改动行 ${result.totalLines} 行` +
    (result.unmeasuredLines > 0
      ? `，另有 ${result.unmeasuredLines} 行不在覆盖率统计范围（不计入）`
      : '');
  return { actual: result.pct, note };
}

function scoreValue(label: string, preset: number | undefined, reason: string): GateValue {
  return typeof preset === 'number' ? { actual: preset } : { unavailableReason: `${label}不可用：${reason}` };
}

function readScopeValue(rule: SopRule, key: string): string | undefined {
  const raw = (rule.content ?? {}) as Record<string, unknown>;
  const check = (raw.check ?? {}) as Record<string, unknown>;
  const scope: Record<string, unknown> = { ...check, ...raw };
  const value = scope[key];
  return typeof value === 'string' ? value : undefined;
}

/** 读取 istanbul json-summary 的总体行覆盖率；不可用返回 undefined */
export function readProjectCoveragePct(
  repoRoot: string,
  candidates: readonly string[] = DEFAULT_COVERAGE_REPORTS,
): number | undefined {
  for (const rel of candidates) {
    const full = path.resolve(repoRoot, rel);
    let raw: string;
    try {
      raw = fs.readFileSync(full, 'utf-8');
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as { total?: { lines?: { pct?: unknown } } };
      const pct = parsed.total?.lines?.pct;
      if (typeof pct === 'number' && Number.isFinite(pct)) return pct;
    } catch {
      // 报告文件损坏：当作没找到，继续尝试下一个候选
    }
  }
  return undefined;
}

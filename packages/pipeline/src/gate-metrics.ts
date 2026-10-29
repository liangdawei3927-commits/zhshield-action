import * as fs from 'node:fs';
import * as path from 'node:path';

import { readGateDeclaration } from '@zh/kernel';
import type { GateValue, SopRule } from '@zh/kernel';

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

export interface GateMetricInputs {
  /** 健康分（0–100）。由评分阶段显式传入；不传则本入口判「未判定」 */
  healthScore?: number;
  /** 质量分（0–100）。同上 */
  qualityScore?: number;
  /** 直接给定覆盖率百分比，跳过读报告（桌面端已有覆盖率数据时用） */
  coveragePct?: number;
  /** 覆盖率报告候选路径（相对 repoRoot），按顺序取第一个存在的 */
  coverageReportPaths?: string[];
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
        return coverageValue(rule, repoRoot, candidates, inputs.coveragePct);
      case 'health-score':
        return scoreValue(
          '健康分',
          inputs.healthScore,
          '健康分是整轮扫描结束后由 @zh/scoring 聚合产出，当前入口（CLI/引擎）不计算聚合评分；' +
            '请在评分阶段（桌面端）判定，或由调用方显式传入 healthScore',
        );
      case 'quality-score':
        return scoreValue(
          '质量分',
          inputs.qualityScore,
          '质量分是整轮扫描结束后由 @zh/scoring 聚合产出，当前入口（CLI/引擎）不计算聚合评分；' +
            '请在评分阶段（桌面端）判定，或由调用方显式传入 qualityScore',
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
  preset: number | undefined,
): GateValue {
  if (typeof preset === 'number') return { actual: preset };

  const scope = readScopeValue(rule, 'scope');
  const pct = readProjectCoveragePct(repoRoot, candidates);

  if (scope === 'diff') {
    // 全量覆盖率不能冒充 diff 覆盖率；基线也未在规则中定义（vs HEAD？vs main？）
    return {
      unavailableReason:
        '规则声明 scope=diff（仅统计本次改动行），而当前只能读到全量覆盖率' +
        (pct === undefined ? '（且未找到覆盖率报告）' : `（全量 ${pct}%）`) +
        '；diff 基线在规则中未定义，按全量代入会与声明口径不符，故不计算',
    };
  }
  if (pct === undefined) {
    return {
      unavailableReason:
        `未找到覆盖率报告（已查找: ${candidates.join(', ')}）。` +
        '需先运行带 json-summary reporter 的测试（如 vitest --coverage）',
    };
  }
  return { actual: pct };
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

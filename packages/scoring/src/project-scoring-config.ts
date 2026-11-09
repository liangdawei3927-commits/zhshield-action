import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSimpleYaml } from '@zh/shared';
import type { ScoringConfig, DimensionDefinition } from './types';
import { getDefaultScoringConfig } from './scoring-config';

/**
 * 项目级评分覆盖机制
 *
 * 项目可在 `<projectRoot>/.zhshield/scoring.yml`（或 `scoring.yaml`）中覆盖默认维度配置的
 * 可序列化子集：维度权重、扣分参数（penalties）、加分规则分值（positiveRules 的 points）。
 * 引擎内部逻辑（condition 函数、评分算法等）不可通过配置文件覆盖。
 *
 * ## 合并语义（deep merge，project > defaults）
 * - 覆盖按维度 id 匹配默认维度；未指定的字段完整继承默认值；
 * - `severityMultipliers` 按 key 合并（覆盖 key 优先，其余保留默认）；
 * - `positiveRules` 按规则 id 匹配，仅允许覆盖 `points`，规则的条件与描述继承默认；
 * - 未被覆盖的维度保持原样。
 *
 * ## 校验策略：fail-fast（快速失败）
 * 覆盖内容非法时抛出 {@link ProjectScoringConfigError}（含文件路径与具体原因），不做静默降级。
 * 理由：评分结果直接驱动门禁与治理决策，静默忽略错误配置比显式失败更危险。
 * 仅当覆盖文件不存在时才回退到纯默认配置（这是正常路径，不是错误）。
 *
 * ## 权重归一化
 * 合并后所有维度权重之和必须为 1（容差 ±0.001，与 DimensionMapper.validateWeights 一致）。
 * 局部调整某个权重时必须同步调整其他权重以保持总和为 1，否则报错并给出当前总和。
 */

/** 扣分参数覆盖（字段级深合并） */
export interface PenaltyOverride {
  maxPenalty?: number;
  perIssuePenalty?: number;
  severityMultipliers?: Record<string, number>;
}

/** 加分规则覆盖 — 按规则 id 匹配，仅可调整分值 */
export interface PositiveRuleOverride {
  points?: number;
}

/** 单个维度的覆盖项 */
export interface DimensionOverride {
  weight?: number;
  penalties?: PenaltyOverride;
  positiveRules?: Record<string, PositiveRuleOverride>;
}

/** `.zhshield/scoring.yml` 的类型化 schema（子集安全：不含引擎内部逻辑） */
export interface ScoringOverrides {
  dimensions?: Record<string, DimensionOverride>;
}

/** 项目级评分配置错误 — 携带来源文件路径（内存构造的覆盖则为 null） */
export class ProjectScoringConfigError extends Error {
  constructor(
    readonly filePath: string | null,
    message: string,
  ) {
    super(filePath ? `${message}（文件：${filePath}）` : message);
    this.name = 'ProjectScoringConfigError';
  }
}

/** 项目配置目录约定（与其余 .zhshield/* 配置一致） */
export const PROJECT_SCORING_CONFIG_DIR = '.zhshield';

/** 候选文件名，按顺序探测（与 ToolsConfigLoader 的 findConfigFile 约定一致） */
export const PROJECT_SCORING_CONFIG_FILENAMES = ['scoring.yml', 'scoring.yaml'] as const;

/** 权重和容差，与 DimensionMapper.validateWeights 保持一致 */
const WEIGHT_SUM_TOLERANCE = 0.001;

/**
 * 在项目根目录下探测评分覆盖文件（`.zhshield/scoring.yml` 或 `.zhshield/scoring.yaml`）。
 * @returns 存在的文件绝对路径；不存在时返回 null
 */
export function findProjectScoringConfigFile(projectRoot: string): string | null {
  for (const name of PROJECT_SCORING_CONFIG_FILENAMES) {
    const p = path.join(projectRoot, PROJECT_SCORING_CONFIG_DIR, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** requireNumber 参数对象 */
interface RequireNumberParams {
  container: Record<string, unknown>;
  key: string;
  label: string;
  filePath: string | null;
  opts?: { min?: number; max?: number };
}

function requireNumber({ container, key, label, filePath, opts = {} }: RequireNumberParams): void {
  const value = container[key];
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProjectScoringConfigError(
      filePath,
      `${label}.${key} 必须是有限数字，实际为 ${JSON.stringify(value)}`,
    );
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ProjectScoringConfigError(
      filePath,
      `${label}.${key} 不能小于 ${opts.min}，实际为 ${value}`,
    );
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ProjectScoringConfigError(
      filePath,
      `${label}.${key} 不能大于 ${opts.max}，实际为 ${value}`,
    );
  }
}

function rejectUnknownKeys(
  container: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  filePath: string | null,
): void {
  for (const key of Object.keys(container)) {
    if (!allowed.includes(key)) {
      throw new ProjectScoringConfigError(
        filePath,
        `${label} 含未知字段 "${key}"，允许的字段：${allowed.join('、')}`,
      );
    }
  }
}

/**
 * 校验从文件解析出的原始对象是否符合 {@link ScoringOverrides} schema。
 * 未知维度、未知规则、未知字段、非法数值一律抛出 {@link ProjectScoringConfigError}。
 */
export function validateScoringOverrides(
  raw: unknown,
  filePath: string | null = null,
): ScoringOverrides {
  if (!isPlainObject(raw)) {
    throw new ProjectScoringConfigError(filePath, '覆盖文件顶层必须是映射（mapping）');
  }
  rejectUnknownKeys(raw, ['dimensions'], '顶层', filePath);

  const dimensions = raw.dimensions;
  if (dimensions === undefined) return {};
  if (!isPlainObject(dimensions)) {
    throw new ProjectScoringConfigError(filePath, 'dimensions 必须是「维度id → 覆盖项」的映射');
  }

  const defaultDimensions = getDefaultScoringConfig().dimensions;
  for (const [dimId, dimOverride] of Object.entries(dimensions)) {
    validateDimensionOverride(dimId, dimOverride, defaultDimensions, filePath);
  }

  return raw as ScoringOverrides;
}

function validateDimensionOverride(
  dimId: string,
  dimOverride: unknown,
  defaultDimensions: DimensionDefinition[],
  filePath: string | null,
): void {
  const defaultDim = defaultDimensions.find((d) => d.id === dimId);
  if (!defaultDim) {
    throw new ProjectScoringConfigError(
      filePath,
      `未知维度 "${dimId}"，可用维度：${defaultDimensions.map((d) => d.id).join('、')}`,
    );
  }
  if (!isPlainObject(dimOverride)) {
    throw new ProjectScoringConfigError(filePath, `维度 "${dimId}" 的覆盖项必须是映射`);
  }
  // R5：评分引擎只消费权重。历史配置里的 penalties/positiveRules 曾被解析、校验、
  // 合并，但生产路径（pipeline-score）从不读取它们 —— 用户以为改了扣分参数，
  // 实际分数一点没变。宁可在加载时明确失败，也不做「看起来生效」的静默忽略。
  // 先于 rejectUnknownKeys 检查：否则通用「未知字段」错误会盖掉这条可操作的提示。
  if (dimOverride.penalties !== undefined) {
    throw new ProjectScoringConfigError(
      filePath,
      `维度 "${dimId}" 的 penalties 未接入生产评分路径；当前只支持 weight 覆盖，请删除该字段`,
    );
  }
  if (dimOverride.positiveRules !== undefined) {
    throw new ProjectScoringConfigError(
      filePath,
      `维度 "${dimId}" 的 positiveRules 未接入生产评分路径；当前只支持 weight 覆盖，请删除该字段`,
    );
  }

  rejectUnknownKeys(dimOverride, ['weight'], `维度 "${dimId}"`, filePath);

  requireNumber({
    container: dimOverride,
    key: 'weight',
    label: `维度 "${dimId}"`,
    filePath,
    opts: { min: 0, max: 1 },
  });
}

/** 深拷贝单个维度定义（PositiveRule.condition 为函数引用，浅拷贝共享即可） */
function cloneDimension(dim: DimensionDefinition): DimensionDefinition {
  return {
    ...dim,
    penalties: { ...dim.penalties, severityMultipliers: { ...dim.penalties.severityMultipliers } },
    positiveRules: dim.positiveRules.map((rule) => ({ ...rule })),
  };
}

/**
 * 将项目级覆盖深合并到基准配置（默认合并到内置默认配置），返回全新对象，不修改任何输入。
 *
 * 合并后校验权重总和必须为 1（容差 ±0.001），否则抛出 {@link ProjectScoringConfigError}。
 *
 * @param overrides 项目级覆盖（应先经 {@link validateScoringOverrides} 校验）
 * @param base 基准配置，缺省使用内置默认配置
 * @throws {ProjectScoringConfigError} 覆盖引用了未知维度/规则，或合并后权重和 ≠ 1
 */
export function mergeScoringOverrides(
  overrides: ScoringOverrides,
  base?: ScoringConfig,
): ScoringConfig {
  const source = base ?? getDefaultScoringConfig();
  const mergedDimensions: DimensionDefinition[] = source.dimensions.map(cloneDimension);

  for (const [dimId, dimOverride] of Object.entries(overrides.dimensions ?? {})) {
    const dim = mergedDimensions.find((d) => d.id === dimId);
    if (!dim) {
      throw new ProjectScoringConfigError(null, `未知维度 "${dimId}"，无法合并覆盖`);
    }
    mergeDimensionOverride(dim, dimOverride);
  }

  assertWeightsNormalized(mergedDimensions);

  return {
    version: source.version,
    lastUpdated: new Date(),
    dimensions: mergedDimensions,
  };
}

function mergeDimensionOverride(dim: DimensionDefinition, dimOverride: DimensionOverride): void {
  // R5：只合并 weight。penalties/positiveRules 在 validateScoringOverrides 已显式拒绝；
  // 直接调用本函数（绕过校验）时也不得让这些字段产生「看起来生效」的假象。
  if (dimOverride.weight !== undefined) dim.weight = dimOverride.weight;
}

function assertWeightsNormalized(mergedDimensions: DimensionDefinition[]): void {
  const sum = mergedDimensions.reduce((s, d) => s + d.weight, 0);
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    const detail = mergedDimensions.map((d) => `${d.id}=${d.weight}`).join(', ');
    throw new ProjectScoringConfigError(
      null,
      `合并后维度权重之和必须为 1（容差 ${WEIGHT_SUM_TOLERANCE}），实际为 ${sum}（${detail}）。请同步调整各维度权重使其归一。`,
    );
  }
}

/**
 * 解析覆盖文件内容（YAML 子集）为已校验的 {@link ScoringOverrides}。
 *
 * @throws {ProjectScoringConfigError} YAML 语法无法解析或内容不符合 schema
 */
export function parseProjectScoringOverrides(
  content: string,
  filePath: string | null = null,
): ScoringOverrides {
  let parsed: unknown;
  try {
    parsed = parseSimpleYaml(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ProjectScoringConfigError(filePath, `覆盖文件解析失败：${reason}`);
  }
  return validateScoringOverrides(parsed, filePath);
}

/**
 * 加载项目的有效评分配置：默认配置 + `.zhshield/scoring.yml|yaml` 项目级覆盖。
 *
 * - 覆盖文件不存在 → 返回纯默认配置（正常路径）；
 * - 覆盖文件存在但非法 → 抛出 {@link ProjectScoringConfigError}（fail-fast，见模块头注释）。
 *
 * @param projectRoot 项目根目录，缺省为 process.cwd()
 * @returns 合并后的 ScoringConfig（全新对象）
 */
export function loadProjectScoringConfig(projectRoot: string = process.cwd()): ScoringConfig {
  const filePath = findProjectScoringConfigFile(projectRoot);
  if (!filePath) return getDefaultScoringConfig();

  const content = fs.readFileSync(filePath, 'utf-8');
  const overrides = parseProjectScoringOverrides(content, filePath);
  return mergeScoringOverrides(overrides);
}

/**
 * 引擎隐式默认配置入口：优先加载项目级覆盖，无覆盖文件时等价于 {@link getDefaultScoringConfig}。
 * 供 ScoringEngine / DimensionMapper 在未显式传入配置时使用。
 *
 * @param projectRoot 项目根目录，缺省为 process.cwd()
 */
export function resolveScoringConfig(projectRoot: string = process.cwd()): ScoringConfig {
  return loadProjectScoringConfig(projectRoot);
}

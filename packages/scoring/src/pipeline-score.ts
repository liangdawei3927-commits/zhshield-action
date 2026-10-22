import type { DimensionScore, DimensionExtras } from './types';
import { DimensionMapper } from './dimension-mapper';
import type { ScoringProjectProfile } from '@zh/fingerprint';
import {
  resolveProfileScoring,
  applyWeightDeltas,
  applyDisabledDimensions,
} from './profile-scoring-resolver';
import { scoreDimension } from './pipeline-score-dimensions';
import type { GuardReportLike, InspectionReportLike } from './pipeline-score-penalties';

// 扣分口径与最小结构类型已拆分至 ./pipeline-score-penalties（零行为变更的结构性拆分）；
// 本文件保留原模块全部导出，供既有 import 路径不变。
export type {
  GuardCheckLike,
  GuardReportLike,
  InspectIssueLike,
  InspectionReportLike,
} from './pipeline-score-penalties';
export {
  RULE_PENALTY_CAP,
  UNTAGGED_PENALTY_CAP,
  DENSITY_REF_ESLOC,
  ISSUE_SEVERITY_CAP,
  GUARD_SEVERITY_CAP,
  SENTINEL_SEVERITY_CAP,
  GARBAGE_TYPE_PENALTY,
  GARBAGE_TYPE_CAP,
  GARBAGE_UNKNOWN_PENALTY,
  GARBAGE_UNKNOWN_CAP,
  BACKUP_FRESH_WINDOW_DAYS,
  BACKUP_STALE_WINDOW_DAYS,
  backupPenalty,
  REFACTOR_SEVERITY_PENALTY,
  REFACTOR_SEVERITY_CAP,
  PERFORMANCE_SEVERITY_PENALTY,
  PERFORMANCE_SEVERITY_CAP,
} from './pipeline-score-penalties';

/**
 * 维度 → inspect issue.category 映射（十域评分体系，v2）。
 * sentinel/garbage/backup/gate/techdebt/refactor/performance 无 category 映射：
 * 分别由 extras 对应域数据计算。
 */
const DIMENSION_CATEGORIES: Record<string, string[]> = {
  quality: ['performance', 'quality', 'architecture', 'refactoring', 'documentation', 'test'],
  security: ['security'],
  dependencies: ['dependency'],
  refactor: [],
  performance: [],
  techdebt: [],
  gate: [],
  sentinel: [],
  garbage: [],
  backup: [],
};

/**
 * 由 guard + inspect + 扩展域数据构建健康维度分（十域评分体系 v2，权重和为 1）。
 * 每个维度满分 100：inspect issues 按 error 扣 8、warning 扣 4、info 扣 1，下限 0；
 * security 额外扣 secrets 活跃密钥；dependencies 额外扣依赖漏洞；techdebt = 100 − debtIndex；
 * refactor 按 smell severity 计权扣分；performance 按 5 级 severity 计权扣分；
 * gate 由 guard 失败/阻塞扣分（v2 起哨兵告警拆出独立 sentinel 维）；
 * sentinel 按事件 critical/warning 计权扣分；garbage 按垃圾类型计权扣分；
 * backup 为状态守护型健康度（新鲜度 + 失败率，见 backupPenalty）。
 *
 * 未检测语义（spec C）：某域从未运行时该域不参与加权且标注 not-run，禁止按满分计。
 * - quality: inspect 为 null → not-run
 * - security: extras.secrets===null 且 inspect 无 security 类 issues → not-run
 * - dependencies: extras.deps===null 且 inspect 无 dependency 类 issues → not-run
 * - techdebt: extras.techdebt===null → not-run
 * - refactor: extras.refactor===null → not-run
 * - performance: extras.performance===null → not-run
 * - gate: guard 为 null → not-run
 *
 * 权重来自项目级评分配置（默认配置 + `.zhshield/scoring.yml` 覆盖，见
 * {@link resolveScoringConfig}）；无覆盖文件时与内置默认权重一致。
 *
 * @param guard guard 报告（可空；null = 门禁未运行）
 * @param inspect inspect 报告（可空；null = 质量巡检未运行）
 * @param projectRoot 项目根目录，缺省为 process.cwd()；传入可显式指定被扫描项目
 * @param profile 项目画像（来自 @zh/fingerprint 的评分契约）；传入时按项目类型自动微调维度权重，
 *   不传则走默认配置（向后兼容）。profile 增量在项目级 .zhshield/scoring.yml 之上叠加。
 * @param extras 扩展域数据（secrets/deps/techdebt/sentinel/refactor/performance）；缺省 = 各域 null = not-run
 * @throws {ProjectScoringConfigError} 项目覆盖文件存在但内容非法时（fail-fast）
 */
/**
 * buildHealthDimensions 参数对象。
 * @param guard guard 报告（可空；null = 门禁未运行）
 * @param inspect inspect 报告（可空；null = 质量巡检未运行）
 * @param projectRoot 项目根目录，缺省为 process.cwd()；传入可显式指定被扫描项目
 * @param profile 项目画像（来自 @zh/fingerprint 的评分契约）；传入时按项目类型自动微调维度权重，
 *   不传则走默认配置（向后兼容）。profile 增量在项目级 .zhshield/scoring.yml 之上叠加。
 * @param extras 扩展域数据（secrets/deps/techdebt/sentinel/refactor/performance）；缺省 = 各域 null = not-run
 */
export interface BuildHealthDimensionsParams {
  guard: GuardReportLike | null;
  inspect: InspectionReportLike | null;
  projectRoot?: string;
  profile?: ScoringProjectProfile | null;
  extras?: DimensionExtras;
}

export function buildHealthDimensions({
  guard,
  inspect,
  projectRoot,
  profile,
  extras,
}: BuildHealthDimensionsParams): DimensionScore[] {
  const dimensionMapper = new DimensionMapper(undefined, projectRoot);
  const weightMap = resolveWeightMap(profile, dimensionMapper);
  const secrets = extras?.secrets ?? null;
  const deps = extras?.deps ?? null;
  const techdebt = extras?.techdebt ?? null;
  const sentinel = extras?.sentinel ?? null;
  const refactor = extras?.refactor ?? null;
  const performance = extras?.performance ?? null;
  const garbage = extras?.garbage ?? null;
  const backup = extras?.backup ?? null;

  return Object.entries(DIMENSION_CATEGORIES).map(([name, categories]) =>
    scoreDimension({
      name,
      categories,
      weightMap,
      guard,
      inspect,
      extras: {
        secrets,
        deps,
        techdebt,
        sentinel,
        refactor,
        performance,
        garbage,
        backup,
      },
    }),
  );
}

/** 画像驱动权重适配：增量叠加 + 不适用维度剔除 + 归一化，向后兼容 */
function resolveWeightMap(
  profile: ScoringProjectProfile | null | undefined,
  dimensionMapper: DimensionMapper,
): Record<string, number> {
  let weightMap = dimensionMapper.getWeightMap();
  if (profile) {
    const overrides = resolveProfileScoring(profile);
    if (overrides.weightDeltas) {
      weightMap = applyWeightDeltas(weightMap, overrides.weightDeltas);
    }
    if (overrides.disabledDimensions?.length) {
      weightMap = applyDisabledDimensions(weightMap, overrides.disabledDimensions);
    }
  }
  return weightMap;
}

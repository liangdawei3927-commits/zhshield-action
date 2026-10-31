/**
 * 十域职责边界契约 —— 统一结果信封（《07-十域职责边界与独立性契约》§5 / §6）。
 *
 * 目的：让 10 个治理域的产出套用同一个外壳，做到「独立可读、独立可校验」。
 * C4「失败不降级为数字」由 `createDomainReport` 强制执行，而不是靠各域自觉：
 *   · `evaluatedChecks = 0` → `score.value = null`（UI 显示「未覆盖」，禁止填 0 或 100）
 *   · 工具不可用/超时 → 只进 `skipped[]`，不进 `issues`、不进 `issuesCount`
 *   · 覆盖率不足 → `uncovered = true`，分数降级为参考值
 *
 * 与 `@zh/shared` 既有的 `Issue`（含 id/category/autoFixable/source）并存：
 * 旧 `Issue` 是跨域聚合的历史表示，本契约的 `DomainIssue` 增加 `owner` 并强制
 * `file` 为相对路径。两者在迁移第 8 步（执行合并）时收敛，此处不做改名以免打断存量消费者。
 */
import type { IssueSeverity } from '../types';

/** 十个治理域 + 报告中心（规范 §三 职责矩阵）。顺序即 UI 分类顺序 */
export const DOMAIN_IDS = [
  'inspect', // 项目体检：质量评分
  'guard', // 门禁系统：准入判定
  'security', // 安全中心：安全风险
  'deps', // 依赖管家：依赖治理
  'garbage', // 垃圾清理：无用物清单
  'performance', // 性能优化：性能建议
  'techdebt', // 技术债务：债务量化
  'refactor', // 代码重构：重构处方
  'sentinel', // 哨兵监控：运行时监控
  'backup', // 备份中心：快照
  'reports', // 报告中心：只读聚合
] as const;

/** 域标识：由 DOMAIN_IDS 运行时常量推导（新增域只能改上面那一处） */
export type DomainId = (typeof DOMAIN_IDS)[number];

/** 域运行状态。`not-run` 与 `unavailable` 是**非失败**的独立语义，不得折算成 0 分 */
export type DomainRunStatus = 'ok' | 'partial' | 'unavailable' | 'not-run';

/** 分数依据：issues = 按问题数扣分；metric = 按单一度量（如重复率）；none = 未覆盖 */
export type ScoreBasis = 'issues' | 'metric' | 'none';

/** 跳过原因（C4：这些情况一律不进入分母） */
export type SkippedReason =
  | 'tool-unavailable'
  | 'tool-timeout'
  | 'no-rules'
  | 'network-unreachable'
  | 'db-unavailable'
  | 'budget-exceeded'
  | 'not-supported';

/** 域内单条问题（规范 §5：必填字段缺一不可） */
export interface DomainIssue {
  /** 带域前缀的规则 id（如 `refactor.scan.official.duplication`） */
  ruleId: string;
  severity: IssueSeverity;
  /** **相对 projectPath** 的文件路径；展示 URI 由 `toFileUri` 统一生成 */
  file: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  /** 唯一 Owner（C1）；等于该域的 DomainId */
  owner: DomainId;
  fingerprint: string;
}

/** 被跳过的检查项：工具不可用 / 超时 / 无规则 / 网络或 DB 不可达 */
export interface SkippedCheck {
  /** 涉及的规则 id（工具级跳过可省略） */
  ruleId?: string;
  /** 工具或检查器名称（如 `trivy`、`osv`） */
  tool: string;
  reason: SkippedReason;
  detail?: string;
}

/** 覆盖率：实际求值 vs 计划求值，用于「0 覆盖不判 100 分」 */
export interface DomainCoverage {
  /** 实际扫描文件数 */
  scannedFiles: number;
  /** 可扫描文件总量 */
  totalFiles: number;
  /** 实际求值的检查项数 */
  evaluatedChecks: number;
  /** 计划检查项数 */
  plannedChecks: number;
}

/** 域分数。`value = null` 表示未覆盖，UI 必须显示「未覆盖 / 待同步规则」 */
export interface DomainScore {
  value: number | null;
  basis: ScoreBasis;
  /** 只计本域 issues（C2 不重复计分） */
  issuesCount: number;
  /** 覆盖率不达标时为 true，分数只能当参考值 */
  uncovered: boolean;
}

/** 统一结果信封：所有域对外输出都必须是这个形状 */
export interface DomainReport {
  domain: DomainId;
  /** 绝对路径，仅用于拼 URI（禁止把绝对路径写进 `issues[].file`） */
  projectPath: string;
  /** ISO 时间 */
  generatedAt: string;
  status: DomainRunStatus;
  coverage: DomainCoverage;
  /** 仅本域 Owner 的问题（非 Owner 一律不得出现在这里） */
  issues: DomainIssue[];
  /** 工具不可用/超时/无规则原因 */
  skipped: SkippedCheck[];
  score: DomainScore;
}

/** 覆盖率阈值（规范 §6.2 建议值）：低于此值分数降级为参考值 */
export const COVERAGE_THRESHOLD = 0.5;

/** `createDomainReport` 入参：分数由域自己算，信封只负责把口径钉死 */
export interface DomainReportInput {
  domain: DomainId;
  projectPath: string;
  generatedAt: string;
  coverage: DomainCoverage;
  issues: readonly DomainIssue[];
  skipped: readonly SkippedCheck[];
  /** 域自算的原始分；未覆盖时会被强制置为 null */
  scoreValue: number | null;
  /** 分数依据；evaluatedChecks = 0 时会被强制置为 'none' */
  basis: ScoreBasis;
}

/**
 * 构造统一信封，并在构造时强制 §6 的口径：
 *
 * 1. `evaluatedChecks === 0` → 有 skipped 则 `unavailable`，否则 `not-run`；`score.value = null`
 * 2. `scannedFiles / totalFiles < COVERAGE_THRESHOLD` → `uncovered = true`、`status = 'partial'`
 * 3. `issuesCount` 只统计本域 issues，工具错误不会混进来（它们只存在于 skipped）
 *
 * 这些规则若留给各域手写，实测已经出现过「0 项检查却给 100 分」和「工具错误计入 total」。
 */
export function createDomainReport(input: DomainReportInput): DomainReport {
  const { domain, projectPath, generatedAt, coverage, issues, skipped, scoreValue, basis } = input;

  const noEvaluation = coverage.evaluatedChecks === 0;
  const uncoveredByCoverage =
    coverage.totalFiles > 0
      ? coverage.scannedFiles / coverage.totalFiles < COVERAGE_THRESHOLD
      : noEvaluation;
  const uncovered = noEvaluation || uncoveredByCoverage;

  let status: DomainRunStatus;
  if (noEvaluation) {
    status = skipped.length > 0 ? 'unavailable' : 'not-run';
  } else {
    status = uncovered ? 'partial' : 'ok';
  }

  const value = noEvaluation || scoreValue === null ? null : scoreValue;

  return {
    domain,
    projectPath,
    generatedAt,
    status,
    coverage: { ...coverage },
    issues: [...issues],
    skipped: [...skipped],
    score: {
      value,
      basis: value === null ? 'none' : basis,
      issuesCount: issues.length,
      uncovered,
    },
  };
}

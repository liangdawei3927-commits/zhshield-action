/** 运行模式：inspection = 只巡检不阻断；guard = 门禁模式 */
export type CheckMode = 'inspection' | 'guard';
/** 单条检查结论：passed 通过 / failed 未通过 / error 执行异常 / warning 通过但有提示 */
export type CheckStatus = 'passed' | 'failed' | 'error' | 'warning';
/** 风险等级档位，作为 CheckOptions.riskLevel 的过滤阈值 */
export type RiskLevel = 'low' | 'medium' | 'high';

/** 门禁/巡检入参：模式、profile、检查项白名单、输出格式、目标路径、风险阈值与 dryRun 开关 */
export interface CheckOptions {
  mode: CheckMode;
  profile?: string;
  checks?: string[];
  format?: 'json' | 'markdown' | 'both';
  target?: string;
  riskLevel?: RiskLevel;
  environment?: string;
  triggerSource?: string;
  dryRun?: boolean;
}

/** 单条检查结果：归一化后的状态/严重级别/是否阻断 + 人类可读 message
 *  （details 为适配器私有负载，duration 为耗时毫秒） */
export interface CheckResult {
  checkId: string;
  adapter: string;
  status: CheckStatus;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
  message: string;
  details?: unknown;
  duration?: number;
}

/** 门禁报告：契约版本 + 运行上下文 + ok 结论（dryRun 时为 null）+ 计数汇总 + 逐条检查结果 */
export interface GuardReport {
  contractVersion: string;
  mode: CheckMode;
  profile: string;
  target: string;
  ok: boolean | null;
  dryRun: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    blocking: number;
    errors: number;
  };
  results: CheckResult[];
  generatedAt: string;
}

/** 单个检查项配置：绑定的适配器、启用状态、适用模式、类别、严重级别与是否阻断 */
export interface CheckConfig {
  checkId: string;
  adapter: string;
  enabled: boolean;
  mode: CheckMode[];
  category: string;
  severity: 'error' | 'warning' | 'info';
  blocking: boolean;
  description: string;
  appliesTo?: { targets?: string[] };
}

/** 门禁执行上下文：项目路径 + 仓库根（可选）+ 限定扫描范围的目标文件列表 */
export interface GuardContext {
  projectPath: string;
  repoRoot?: string;
  targetFiles?: string[];
}

/** 门禁适配器契约：run 产出原始结果，normalize 将其归一化为 CheckResult */
export interface Adapter {
  run(context: GuardContext, check: CheckConfig): unknown;
  normalize(rawResult: unknown, context: GuardContext, check: CheckConfig): CheckResult;
}

import type { CheckConfig, CheckResult, CheckStatus } from '../types';

/** 扫描类适配器共用的上下文：仓库根或被检项目目录，二者至少提供一个 */
export interface AdapterScanContext {
  repoRoot?: string;
  projectPath?: string;
}

/**
 * 门禁适配器统一的结果构造（各适配器私有 makeResult 的唯一实现）。
 * failed / error 时沿用 check 声明的 severity 与 blocking 判定，
 * 其余状态（passed / warning / skipped）降级为 info 且不阻断。
 */
export function makeAdapterResult(
  check: CheckConfig,
  status: CheckStatus,
  message: string,
  details?: unknown,
): CheckResult {
  return {
    checkId: check.checkId,
    adapter: check.adapter,
    status,
    severity: status === 'failed' || status === 'error' ? check.severity : 'info',
    blocking: check.blocking && (status === 'failed' || status === 'error'),
    message,
    details,
  };
}

/** ESLint 消息形状统一在 `@zh/shared` 定义，此处转出保持适配器侧导入路径不变。 */
export type { EslintMessage } from '@zh/shared';

/**
 * lint 类适配器共用的「错误 / 警告 / 通过」三态判定。
 *
 * eslint-check 与 sonarway-eslint 两个适配器此前各写一遍同一套策略：
 * 有错误 → failed；有警告且 check.severity 不是 error → warning；否则 passed。
 * 这是**门禁严重度**规则（决定该检查是否阻断合并），两处各写一份意味着策略
 * 可能在一边被单独改掉 —— 而两条 lint 通道检出的是同一类问题，口径必须一致。
 *
 * 差异只有工具名与「通过」话术，由调用方传入。
 */
export function buildLintOutcome(
  check: CheckConfig,
  params: {
    /** 工具显示名（拼进 failed / warning 的 message） */
    tool: string;
    errors: readonly (string | undefined)[];
    warnings: readonly (string | undefined)[];
    /** 通过时的话术 */
    passedMessage: string;
  },
): CheckResult {
  const { tool, errors, warnings, passedMessage } = params;
  if (errors.length > 0) {
    return makeAdapterResult(
      check,
      'failed',
      `${tool} 发现 ${errors.length} 个错误:\n${errors.join('\n')}`,
      { errors, warnings, totalErrors: errors.length, totalWarnings: warnings.length },
    );
  }

  if (warnings.length > 0 && check.severity !== 'error') {
    return makeAdapterResult(
      check,
      'warning',
      `${tool} 发现 ${warnings.length} 个警告:\n${warnings.join('\n')}`,
      { errors, warnings, totalErrors: 0, totalWarnings: warnings.length },
    );
  }

  return makeAdapterResult(check, 'passed', passedMessage);
}

/** 从上下文解析待扫描目录；两者都缺失时抛出带 checkId 的定位错误 */
export function resolveScanTargetDir(context: AdapterScanContext, checkId: string): string {
  const targetDir = context.repoRoot || context.projectPath;
  if (!targetDir) {
    throw new Error(`${checkId}: 缺少 projectPath/repoRoot 上下文，无法确定扫描目录`);
  }
  return targetDir;
}

/** 扫描期捕获的异常统一转消息串（非 Error 走 String()） */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 「跳过」结果：status=warning + severity=warning + blocking=false。
 *
 * 不复用 {@link makeAdapterResult}——那里会把非 failed/error 的 severity 压成 info，
 * 导致跳过的检查在汇总里彻底消失（warnings 计数为 0，用户看不见覆盖率缺口）。
 * 用 warning 而非新增 skipped 状态，是为了与 GuardEngine 既有的
 * EVAL_STATUS_MAP（SOP skipped → warning）保持同一套口径。
 *
 * blocking 必须为 false：TEST-001 在 checks.json 里 blocking=true，
 * 走 makeAdapterResult 会让「项目没配测试」直接阻断门禁。
 */
export function makeSkippedAdapterResult(check: CheckConfig, reason: string): CheckResult {
  return {
    checkId: check.checkId,
    adapter: check.adapter,
    status: 'warning',
    severity: 'warning',
    blocking: false,
    message: `已跳过：${reason}`,
    details: { skipped: true, reason },
  };
}

/**
 * 扫描型适配器 run() 的统一骨架：解析扫描目录 → 交给 scan 回调收集 findings → 异常转 error 字段。
 *
 * 架构边界 / 安全扫描 / 敏感信息三个适配器的 run() 此前逐字重复（仅 scanProject 内部不同），
 * 此处收敛为唯一实现。语义保持一致：目录解析失败（缺 repoRoot 与 projectPath）仍向上抛，
 * 扫描期异常才转成 `{ findings: [], error }`。
 */
export function runScanAdapter<TFinding>(
  context: AdapterScanContext,
  checkId: string,
  scan: (targetDir: string, findings: TFinding[]) => void,
): { findings: TFinding[]; error?: string } {
  const targetDir = resolveScanTargetDir(context, checkId);
  const findings: TFinding[] = [];
  try {
    scan(targetDir, findings);
  } catch (error: unknown) {
    return { findings: [], error: toErrorMessage(error) };
  }
  return { findings };
}

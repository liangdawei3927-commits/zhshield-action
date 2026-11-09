/**
 * CLI 命令实现的共享支撑（R5 期间从 commands.ts 抽出）。
 *
 * 为什么单独成文件：`commands.ts` 已接近 zhcheck 的 500 行上限，新增 `guard-hook`
 * 分支后触发 `oversized-file` 门禁。这里放的是「报告落盘 + 阻断判定 + 降级护栏」
 * 这组与具体子命令无关的纯支撑函数，commands.ts 与 guard-hook.ts 共用，避免循环
 * import（commands.ts → guard-hook.ts → commands.ts）。
 */
import * as path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  buildFindings,
  toSarif,
  formatReportJson,
  severityRank,
  failOnRank,
  type Finding,
  type FailOn,
} from '@zh/reporter';
import { countDegraded } from './degraded';
import type { CLIOptions } from './cli-options';

/** 可写机器可读报告的命令；各命令报告 schema 不同，默认落盘名必须区分 */
export type ReportCommand =
  | 'inspect'
  | 'inspect-sop'
  | 'guard'
  | 'guard-sop'
  | 'guard-hook'
  | 'refactor'
  | 'pipeline';

/**
 * 各命令的默认报告名基名。
 *
 * inspect 保留 zhshield.json 是因为 MCP 首次引导回退读该文件（desktop/electron/
 * zhshield-mcp.ts），改名会断。`--sop` 分支产出的是 RuleEngineReport，与默认路径
 * 的 InspectionReport / GuardReport 是不同 schema，必须单独命名。
 */
export const DEFAULT_REPORT_BASE: Record<ReportCommand, string> = {
  inspect: 'zhshield',
  'inspect-sop': 'zhshield-sop',
  guard: 'zhshield-guard',
  'guard-sop': 'zhshield-guard-sop',
  'guard-hook': 'zhshield-guard-hook',
  refactor: 'zhshield-refactor',
  pipeline: 'zhshield-pipeline',
};

/** 报告落盘目标：项目根与命令合为一个上下文，避免函数参数列表过长 */
export interface ReportTarget {
  projectDir: string;
  command: ReportCommand;
}

/** SARIF artifactLocation 要求仓库相对路径；引擎产出多为绝对路径，统一转为相对项目根 */
function relativizeFindings(findings: Finding[], projectDir: string): void {
  for (const f of findings) {
    if (f.file && path.isAbsolute(f.file)) {
      f.file = path.relative(projectDir, f.file);
    }
  }
}

/** 由报告派生出 findings，并按 failOn 判定是否阻断 */
export function shouldBlock(
  report: unknown,
  failOn: FailOn,
  dryRun: boolean,
  projectDir: string,
): { findings: Finding[]; blocked: boolean } {
  const findings = buildFindings(report);
  relativizeFindings(findings, projectDir);
  const blocked =
    !dryRun &&
    failOn !== 'none' &&
    findings.some((f) => severityRank(f.severity) >= failOnRank(failOn));
  return { findings, blocked };
}

/** 机器可读报告落盘；父目录不存在时递归创建（CI 传 reports/xxx.json 不应要求预建目录） */
export function writeReportFile(
  opts: CLIOptions,
  report: unknown,
  findings: Finding[],
  target: ReportTarget,
): void {
  const { projectDir, command } = target;
  const base = DEFAULT_REPORT_BASE[command];
  if (opts.format === 'sarif') {
    const outPath = opts.report || `${base}.sarif`;
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, toSarif(findings), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  if (opts.format === 'json') {
    const outPath = opts.report || `${base}.json`;
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, formatReportJson(report), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  // text 或未知格式：不写机器可读文件
}

/** P0（复查4）降级护栏：degraded > 0 → 告警 + exit 2（未检测 ≠ 通过） */
export function applyDegradedGuard(report?: unknown, subReports?: unknown[]): void {
  const degraded = subReports
    ? subReports.reduce<number>((n, r) => n + countDegraded(r), 0)
    : countDegraded(report);
  if (degraded > 0) {
    console.error(
      `[CLI] 降级警告: ${degraded} 项检查未实际执行（工具不可用/引擎缺失）—— 未检测 ≠ 通过，按门禁失败处理（exit 2）。`,
    );
    process.exitCode = 2;
  }
}

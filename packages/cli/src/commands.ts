// zhshield CLI 命令实现层：guard / inspect / refactor / pipeline / baseline 五个子命令
// 的执行、报告落盘与降级护栏。自 index.ts 原样抽出（仅搬移，无逻辑改动）；
// index.ts 保留参数解析（parseFlags 长方法基线）与 main/runPipeline 主流程调度。

import type { PipelineRunner } from '@zh/pipeline';
import {
  buildFindings,
  toSarif,
  formatReportJson,
  severityRank,
  failOnRank,
  type ConsoleReporter,
  type Finding,
  type FailOn,
} from '@zh/reporter';
import {
  issuesToBaselineEntries,
  saveBaseline,
  loadBaseline,
  clearBaseline,
  baselinePath,
  baselineEntryKey,
  isBaselineEntryActive,
} from '@zh/shared';
import * as path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { countDegraded } from './degraded';
import type { CLIOptions } from './cli-options';

function shouldBlock(
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

/** SARIF artifactLocation 要求仓库相对路径；引擎产出多为绝对路径，
 *  统一转为相对项目根（--dir 解析后的 projectPath），否则 GitHub Code Scanning 无法映射到仓库文件 */
function relativizeFindings(findings: Finding[], projectDir: string): void {
  for (const f of findings) {
    if (f.file && path.isAbsolute(f.file)) {
      f.file = path.relative(projectDir, f.file);
    }
  }
}

/** 机器可读报告落盘。父目录不存在时递归创建——CI 传 reports/xxx.json
 *  不应要求预建目录，裸抛 ENOENT 会把产物链路变成难排查的崩溃栈。 */
function writeReportFile(
  opts: CLIOptions,
  report: unknown,
  findings: Finding[],
  projectDir: string,
): void {
  if (opts.format === 'sarif') {
    const outPath = opts.report || 'zhshield.sarif';
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, toSarif(findings), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  if (opts.format === 'json') {
    const outPath = opts.report || 'zhshield.json';
    const absPath = path.resolve(projectDir, outPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, formatReportJson(report), 'utf8');
    console.error(`[CLI] 报告已写入: ${outPath}`);
    return;
  }
  // text 或未知格式：不写机器可读文件
}

/** 输出错误报告并退出 */
export function handleError(reporter: ConsoleReporter, err: unknown): void {
  console.error(
    reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: null,
      refactor: null,
      passed: false,
      stage: 'complete',
      error: err instanceof Error ? err.message : String(err),
    }).text,
  );
  process.exit(1);
}

/** P0（复查4）降级护栏（全路径统一）：degraded > 0 → 告警 + exit 2。
 *  此前该判定只存在于 --sop 分支，默认路径 8 项全跳过仍 100 分通过（盲检）。 */
function applyDegradedGuard(report?: unknown, subReports?: unknown[]): void {
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

export async function runGuardCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopGuard({ dryRun: opts.dryRun });
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    writeReportFile(opts, report, findings, projectDir);
    applyDegradedGuard(report);
    process.exit(blocked ? 1 : process.exitCode);
  } else {
    const report = await runner.runGuard({ dryRun: opts.dryRun });
    const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: report,
      inspect: null,
      refactor: null,
      passed: !blocked,
      stage: 'guard',
    });
    console.log(formatted.text);
    writeReportFile(opts, report, findings, projectDir);
    applyDegradedGuard(report);
    process.exit(blocked ? 1 : process.exitCode);
  }
}

export async function runInspectCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  if (opts.sop) {
    const report = await runner.runSopInspect();
    const formatted = reporter.formatRuleEngine(report);
    console.log(formatted.text);
    const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
    writeReportFile(opts, report, findings, projectDir);
    applyDegradedGuard(report);
    process.exit(blocked ? 1 : process.exitCode);
  } else {
    const report = await runner.runInspect();
    const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
    const formatted = reporter.format({
      timestamp: new Date(),
      guard: null,
      inspect: report,
      refactor: null,
      passed: !blocked,
      stage: 'inspect',
    });
    console.log(formatted.text);
    writeReportFile(opts, report, findings, projectDir);
    applyDegradedGuard(report);
    process.exit(blocked ? 1 : process.exitCode);
  }
}

export async function runRefactorCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  const report = await runner.runRefactor();
  const { findings, blocked } = shouldBlock(report, opts.failOn, false, projectDir);
  // 注：refactor 是纯 AST 静态分析、不依赖外部工具，无"检查未实际执行"的降级场景
  // （countDegraded 对 RefactorReport 恒为 0），故此处有意不调 applyDegradedGuard。
  const formatted = reporter.format({
    timestamp: new Date(),
    guard: null,
    inspect: null,
    refactor: report,
    passed: !blocked,
    stage: 'refactor',
  });
  console.log(formatted.text);
  writeReportFile(opts, report, findings, projectDir);
  process.exit(blocked ? 1 : process.exitCode);
}

export async function runBaselineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  _reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  switch (opts.baselineAction) {
    case 'capture': {
      const report = await runner.runInspect({ skipBaseline: true });
      const sopReport = await runner.runSopInspect(undefined, { skipBaseline: true });
      const sopViolations = sopReport.evaluations.flatMap((ev) => ev.violations ?? []);
      // 两个来源可能产出同一条（直扫与 SOP 规则重叠），按匹配键去重避免基线里出现重复条目
      const merged = [
        ...issuesToBaselineEntries(report.issues, projectDir),
        ...issuesToBaselineEntries(sopViolations, projectDir),
      ];
      const seen = new Set<string>();
      const entries = merged.filter((e) => {
        const key = baselineEntryKey(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const saved = await saveBaseline(projectDir, entries);
      console.log(
        `基线已捕获: ${entries.length} 项问题（直扫 ${report.issues.length} + SOP ${sopViolations.length}，去重后 ${entries.length}）→ ${baselinePath(projectDir)} (${saved.capturedAt})`,
      );
      console.log('提示：带 reason/owner/expiresAt 的条目才是可审计豁免，建议手工补齐后再入库');
      process.exit(process.exitCode);
      break;
    }
    case 'list': {
      const baseline = await loadBaseline(projectDir);
      if (!baseline) {
        console.log('尚未捕获基线（无 .zhshield/baseline.json）');
        process.exit(0);
        break;
      }
      const expired = baseline.entries.filter((e) => !isBaselineEntryActive(e)).length;
      console.log(`基线 ${baseline.entries.length} 项，捕获于 ${baseline.capturedAt}`);
      if (expired > 0) {
        console.log(`其中 ${expired} 项已过期失效（不参与豁免，问题会重新计入报告）`);
      }
      for (const entry of baseline.entries) {
        const state = isBaselineEntryActive(entry) ? '' : '  [已过期]';
        const reason = entry.reason ? `  理由: ${entry.reason}` : '  [未记录理由]';
        const owner = entry.owner ? `  责任人: ${entry.owner}` : '';
        const expires = entry.expiresAt ? `  到期: ${entry.expiresAt}` : '  [永久]';
        console.log(
          `  ${entry.ruleId}  ${entry.file}:${entry.line}:${entry.column}${state}${reason}${owner}${expires}`,
        );
      }
      process.exit(process.exitCode);
      break;
    }
    case 'clear': {
      await clearBaseline(projectDir);
      console.log(`基线已清除: ${baselinePath(projectDir)}`);
      process.exit(process.exitCode);
      break;
    }
  }
  console.error('未知 baseline 子命令，支持: capture | list | clear');
  process.exit(1);
}

export async function runPipelineCommand(
  runner: PipelineRunner,
  opts: CLIOptions,
  reporter: ConsoleReporter,
  projectDir: string,
): Promise<void> {
  const report = opts.sop
    ? await runner.runSopDrivenPipeline()
    : await runner.runFullPipeline({ dryRun: opts.dryRun });

  const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
  const formatted = reporter.format(report);
  console.log(formatted.text);
  writeReportFile(opts, report, findings, projectDir);
  applyDegradedGuard(undefined, [report.guard, report.inspect]);
  process.exit(blocked ? 1 : process.exitCode);
}

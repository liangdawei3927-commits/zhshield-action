/**
 * `--hook pre-commit|pre-push` 门禁判定（R5 期间从 commands.ts 抽出）。
 *
 * 与 `--sop` 同源：纯判定、只读各供应商域已落盘结论、不派发扫描器（《07》O8），
 * 且不跑后置门禁（健康分/覆盖率是整轮扫描聚合值，属 L3/评分阶段）。
 * 两种收场都必须在终端说清楚「到底判没判」——钩子安静退出 0 会被当成通过。
 */
import { loadGuardConclusions, type PipelineRunner } from '@zh/pipeline';
import type { ConsoleReporter } from '@zh/reporter';
import type { CLIOptions } from './cli-options';
import { finalizeScan, isRequireSop } from './sop-banner';
import { applyDegradedGuard, shouldBlock, writeReportFile } from './command-support';

/** 钩子阶段参数：合并为对象，避免 `long-parameter-list`（阈值 4 个位置参数） */
interface GuardHookParams {
  runner: PipelineRunner;
  opts: CLIOptions;
  reporter: ConsoleReporter;
  projectDir: string;
  hook: NonNullable<CLIOptions['hook']>;
}

/** 钩子阶段「未实际判定」的统一收场：默认宽松放行，显式开关下升格为失败 */
function finishUndeterminedHook(reason: string): void {
  console.error(reason);
  if (isRequireSop(process.env)) {
    console.error('[CLI] ZH_GATE_REQUIRE_SOP 已开启：缺证据按门禁失败处理（exit 2）。');
    process.exitCode = 2;
    return;
  }
  console.error(
    '[CLI] 本次准入未经门禁实际判定（宽松默认放行）；设置 ZH_GATE_REQUIRE_SOP=1 可升格为失败。',
  );
}

export async function runGuardHookCommand({
  runner,
  opts,
  reporter,
  projectDir,
  hook,
}: GuardHookParams): Promise<void> {
  const conclusions = await loadGuardConclusions(projectDir);
  if (Object.keys(conclusions).length === 0) {
    finishUndeterminedHook(
      `[CLI] 门禁钩子（${hook}）无法判定：未发现供应商域快照（inspect/security/deps 均未落盘）。\n` +
        '[CLI] 这不是通过——请先运行对应域（桌面端一键体检或 `zhshield pipeline --full`）。',
    );
    finalizeScan(runner, { sop: false }, false);
    return;
  }

  const report = await runner.runSopGuard({ dryRun: opts.dryRun, conclusions });
  if (report.total === 0) {
    finishUndeterminedHook('[CLI] 门禁钩子：SOP 规则为 0 条，本次未实际判定。');
    finalizeScan(runner, { sop: false }, false);
    return;
  }

  console.log(reporter.formatRuleEngine(report).text);
  const { findings, blocked } = shouldBlock(report, opts.failOn, opts.dryRun, projectDir);
  writeReportFile(opts, report, findings, { projectDir, command: 'guard-hook' });
  applyDegradedGuard(report);
  finalizeScan(runner, { sop: false }, blocked);
}

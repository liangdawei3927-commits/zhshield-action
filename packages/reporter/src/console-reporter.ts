import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport } from '@zh/kernel';
import type { ReportFormatOptions, FormattedReport } from './types';
import { ConsoleReporterFormat } from './console-reporter-format';
import { RuleEngineSectionFormatter } from './console-reporter-rule-engine';
import { StageSectionFormatter } from './console-reporter-sections';

/**
 * ConsoleReporter — 将流水线报告格式化为终端可读的树形文本
 *
 * 支持两种输入格式：
 * - PipelineReport（完整流水线）
 * - RuleEngineReport（SOP 驱动模式）
 *
 * 渲染职责已按内聚拆分到：
 * - ConsoleReporterFormat（颜色工具）
 * - RuleEngineSectionFormatter（规则引擎报告渲染）
 * - StageSectionFormatter（Guard/Inspect/Refactor 阶段渲染）
 * 本类保留公共 API 并委托给上述职责类。
 */
export class ConsoleReporter {
  private fmt: ConsoleReporterFormat;
  private ruleEngine: RuleEngineSectionFormatter;
  private stages: StageSectionFormatter;

  constructor(options?: ReportFormatOptions) {
    this.fmt = new ConsoleReporterFormat(options?.color ?? true);
    this.ruleEngine = new RuleEngineSectionFormatter(this.fmt);
    this.stages = new StageSectionFormatter(this.fmt, this.ruleEngine);
  }

  // ─── 顶层入口 ──────────────────────────────────────────

  /**
   * 格式化 PipelineReport（完整流水线）
   */
  format(report: PipelineReport): FormattedReport {
    const lines: string[] = [];

    this.formatReportHeader(report, lines);
    this.stages.formatGuardStage(report, lines);
    this.stages.formatInspectStage(report, lines);
    this.stages.formatRefactorStage(report, lines);
    this.formatReportVerdict(report, lines);

    return {
      text: lines.join('\n'),
      passed: report.passed,
    };
  }

  /** 渲染报告头部：标题、时间、状态、阶段与错误 */
  private formatReportHeader(report: PipelineReport, lines: string[]): void {
    lines.push('');
    lines.push(this.fmt.header('智汇码盾 — 代码质量管理报告'));
    lines.push(this.fmt.dim(`时间: ${report.timestamp.toISOString()}`));
    lines.push(this.fmt.dim(`状态: ${report.passed ? '✅ 通过' : '❌ 失败'}`));
    lines.push(this.fmt.dim(`阶段: ${report.stage}`));
    if (report.error) {
      lines.push(this.fmt.red(`错误: ${report.error}`));
    }
    lines.push('');
  }

  /** 渲染流水线结论 */
  private formatReportVerdict(report: PipelineReport, lines: string[]): void {
    const verdict = report.passed ? this.fmt.green('✓ 流水线通过') : this.fmt.red('✗ 流水线失败');
    lines.push(this.fmt.header(verdict));
    lines.push('');
  }

  /**
   * 格式化 RuleEngineReport（SOP 驱动模式）
   */
  formatRuleEngine(report: RuleEngineReport): FormattedReport {
    const lines: string[] = [];
    lines.push('');
    lines.push(this.fmt.header('SOP 规则引擎报告'));
    this.ruleEngine.format(report, lines, '');
    lines.push('');

    const passed = report.ok;
    const verdict = passed ? this.fmt.green('✓ 引擎检查通过') : this.fmt.red('✗ 引擎检查失败');
    lines.push(this.fmt.header(verdict));
    lines.push('');

    return { text: lines.join('\n'), passed };
  }
}

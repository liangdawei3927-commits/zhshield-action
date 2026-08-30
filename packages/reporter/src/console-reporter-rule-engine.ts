import type { RuleEngineReport, RuleEvaluation, Violation } from '@zh/kernel';
import type { ConsoleReporterFormat } from './console-reporter-format';

/**
 * RuleEngineSectionFormatter — 将规则引擎报告（SOP 驱动模式）格式化为终端文本行
 *
 * 从 ConsoleReporter 拆分而来，职责单一：规则引擎报告的汇总、分类统计、
 * 失败/错误/跳过/通过规则明细与违规详情渲染。
 */
export class RuleEngineSectionFormatter {
  private fmt: ConsoleReporterFormat;

  constructor(fmt: ConsoleReporterFormat) {
    this.fmt = fmt;
  }

  /** 渲染规则引擎报告主体（不含外层标题与结论） */
  format(report: RuleEngineReport, lines: string[], indent: string): void {
    this.formatSummary(report, lines, indent);
    this.formatCategoryBreakdown(report, lines, indent);
    lines.push(`${indent}${this.fmt.dim(`耗时: ${report.durationMs}ms`)}`);

    if (report.total === 0) {
      lines.push(`${indent}${this.fmt.dim('(无匹配规则)')}`);
      return;
    }

    this.formatFailedRules(report, lines, indent);
    this.formatErrorRules(report, lines, indent);
    this.formatSkippedRules(report, lines, indent);
    this.formatPassedRules(report, lines, indent);
  }

  /** 渲染规则引擎汇总行 */
  private formatSummary(report: RuleEngineReport, lines: string[], indent: string): void {
    const total = report.total;
    const passed = report.passed;
    const failed = report.failed;
    const errors = report.errors;
    const skipped = report.skipped;

    lines.push(`${indent}${this.fmt.bold('汇总')}: ${`${this.fmt.bold(String(total))} ${this.fmt.dim('条规则')}`}`);
    lines.push(`${indent}  通过: ${this.fmt.green(String(passed))}  失败: ${this.fmt.red(String(failed))}  ` +
      `错误: ${this.fmt.yellow(String(errors))}  跳过: ${this.fmt.gray(String(skipped))}`);
  }

  /** 渲染按 issue category 统计的违规分类汇总 */
  private formatCategoryBreakdown(report: RuleEngineReport, lines: string[], indent: string): void {
    const allViolations = report.evaluations
      .filter((e) => e.status === 'failed' && e.violations)
      .flatMap((e) => e.violations!);
    const categoryCounts = new Map<string, number>();
    for (const v of allViolations) {
      const cat = v.category ?? 'uncategorized';
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
    if (categoryCounts.size > 0) {
      const catParts = [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cat, count]) => `${this.fmt.magenta(cat)} ${this.fmt.bold(String(count))}`);
      lines.push(`${indent}  分类: ${catParts.join(this.fmt.dim(', '))}`);
    }
  }

  /** 渲染失败的规则详情 */
  private formatFailedRules(report: RuleEngineReport, lines: string[], indent: string): void {
    const failedEvals = report.evaluations.filter((e) => e.status === 'failed');
    if (failedEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.fmt.bold(this.fmt.red('失败规则:'))}`);
      for (const eval_ of failedEvals) {
        this.formatRuleEvaluation(eval_, lines, `${indent}  `);
      }
    }
  }

  /** 渲染出错的规则 */
  private formatErrorRules(report: RuleEngineReport, lines: string[], indent: string): void {
    const errorEvals = report.evaluations.filter((e) => e.status === 'error');
    if (errorEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.fmt.bold(this.fmt.yellow('错误规则:'))}`);
      for (const eval_ of errorEvals) {
        lines.push(`${indent}  ${this.fmt.yellow(`⚠ ${eval_.rule.id}: ${eval_.message ?? ''}`)}`);
      }
    }
  }

  /** 渲染跳过的规则明细（含跳过原因） */
  private formatSkippedRules(report: RuleEngineReport, lines: string[], indent: string): void {
    const skippedEvals = report.evaluations.filter((e) => e.status === 'skipped');
    if (skippedEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.fmt.bold(this.fmt.gray('跳过规则:'))}`);
      for (const eval_ of skippedEvals) {
        lines.push(`${indent}  ${this.fmt.gray('-')} ${eval_.rule.id}${eval_.message ? ' — ' + eval_.message : ''}`);
      }
    }
  }

  /** 渲染通过的规则（紧凑模式） */
  private formatPassedRules(report: RuleEngineReport, lines: string[], indent: string): void {
    const passedEvals = report.evaluations.filter((e) => e.status === 'passed');
    if (passedEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.fmt.bold('通过规则:')}`);
      for (const eval_ of passedEvals) {
        lines.push(`${indent}  ${this.fmt.green('✓')} ${eval_.rule.id}${eval_.message ? ' — ' + eval_.message : ''}`);
      }
    }
  }

  private formatRuleEvaluation(eval_: RuleEvaluation, lines: string[], indent: string): void {
    this.formatRuleStatusLine(eval_, lines, indent);
    this.formatRuleMessage(eval_, lines, indent);
    this.formatRuleViolations(eval_, lines, indent);
    this.formatRuleFiles(eval_, lines, indent);
  }

  /** 渲染规则状态图标与规则 ID 行 */
  private formatRuleStatusLine(eval_: RuleEvaluation, lines: string[], indent: string): void {
    const statusIcon = eval_.status === 'passed' ? this.fmt.green('✓') :
      eval_.status === 'failed' ? this.fmt.red('✗') :
      eval_.status === 'error' ? this.fmt.yellow('⚠') : this.fmt.gray('-');

    lines.push(`${indent}${statusIcon} ${this.fmt.bold(eval_.rule.id)} (${eval_.rule.severity})`);
  }

  /** 渲染规则消息 */
  private formatRuleMessage(eval_: RuleEvaluation, lines: string[], indent: string): void {
    if (eval_.message) {
      lines.push(`${indent}  ${this.fmt.dim(eval_.message)}`);
    }
  }

  /** 渲染违规详情（最多展示 10 条） */
  private formatRuleViolations(eval_: RuleEvaluation, lines: string[], indent: string): void {
    if (eval_.violations && eval_.violations.length > 0) {
      const shown = eval_.violations.slice(0, 10);
      for (const v of shown) {
        this.formatViolation(v, lines, `${indent}    `);
      }
      if (eval_.violations.length > 10) {
        lines.push(`${indent}    ${this.fmt.dim(`... 及另外 ${eval_.violations.length - 10} 项`)}`);
      }
    }
  }

  /** 渲染涉及文件数量 */
  private formatRuleFiles(eval_: RuleEvaluation, lines: string[], indent: string): void {
    if (eval_.files && eval_.files.length > 0) {
      lines.push(`${indent}  ${this.fmt.dim(`涉及文件: ${eval_.files.length} 个`)}`);
    }
  }

  private formatViolation(violation: Violation, lines: string[], indent: string): void {
    const location = violation.line
      ? `${violation.file}:${violation.line}`
      : violation.file;
    const locColor = violation.severity === 'critical' || violation.severity === 'high'
      ? this.fmt.red(location) : this.fmt.yellow(location);

    const catTag = violation.category ? `${this.fmt.magenta(`[${violation.category}]`)} ` : '';
    lines.push(`${indent}${this.fmt.dim('•')} ${locColor}`);
    lines.push(`${indent}  ${catTag}${violation.message}`);
    if (violation.suggestion) {
      lines.push(`${indent}  ${this.fmt.dim('建议:')} ${violation.suggestion}`);
    }
  }
}

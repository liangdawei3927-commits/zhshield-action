import type { RuleEngineReport, RuleEvaluation, Violation } from '@zh/kernel';
import type { ConsoleReporterFormat, RenderTarget } from './console-reporter-format';
import { tallyViolationsByCategory } from './rule-engine-formatter';

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
    const rt: RenderTarget = { lines, indent };
    this.formatSummary(report, rt);
    this.formatCategoryBreakdown(report, rt);
    rt.lines.push(`${rt.indent}${this.fmt.dim(`耗时: ${report.durationMs}ms`)}`);

    if (report.total === 0) {
      rt.lines.push(`${rt.indent}${this.fmt.dim('(无匹配规则)')}`);
      return;
    }

    this.formatFailedRules(report, rt);
    this.formatErrorRules(report, rt);
    this.formatSkippedRules(report, rt);
    this.formatPassedRules(report, rt);
  }

  /** 渲染规则引擎汇总行 */
  private formatSummary(report: RuleEngineReport, rt: RenderTarget): void {
    const total = report.total;
    const passed = report.passed;
    const failed = report.failed;
    const errors = report.errors;
    const skipped = report.skipped;
    const degraded = report.degraded ?? 0;

    rt.lines.push(
      `${rt.indent}${this.fmt.bold('汇总')}: ${`${this.fmt.bold(String(total))} ${this.fmt.dim('条规则')}`}`,
    );
    rt.lines.push(
      `${rt.indent}  通过: ${this.fmt.green(String(passed))}  失败: ${this.fmt.red(String(failed))}  ` +
        `错误: ${this.fmt.yellow(String(errors))}  跳过: ${this.fmt.gray(String(skipped))}` +
        (degraded > 0 ? `  降级: ${this.fmt.yellow(String(degraded))}` : ''),
    );
  }

  /** 渲染按 issue category 统计的违规分类汇总 */
  private formatCategoryBreakdown(report: RuleEngineReport, rt: RenderTarget): void {
    const categories = tallyViolationsByCategory(report.evaluations);
    if (categories.length > 0) {
      const catParts = categories.map(
        ([cat, count]) => `${this.fmt.magenta(cat)} ${this.fmt.bold(String(count))}`,
      );
      rt.lines.push(`${rt.indent}  分类: ${catParts.join(this.fmt.dim(', '))}`);
    }
  }

  /** 渲染失败的规则详情 */
  private formatFailedRules(report: RuleEngineReport, rt: RenderTarget): void {
    const failedEvals = report.evaluations.filter((e) => e.status === 'failed');
    if (failedEvals.length > 0) {
      rt.lines.push('');
      rt.lines.push(`${rt.indent}${this.fmt.bold(this.fmt.red('失败规则:'))}`);
      for (const eval_ of failedEvals) {
        this.formatRuleEvaluation(eval_, { lines: rt.lines, indent: `${rt.indent}  ` });
      }
    }
  }

  /** 渲染出错的规则 */
  private formatErrorRules(report: RuleEngineReport, rt: RenderTarget): void {
    const errorEvals = report.evaluations.filter((e) => e.status === 'error');
    if (errorEvals.length > 0) {
      rt.lines.push('');
      rt.lines.push(`${rt.indent}${this.fmt.bold(this.fmt.yellow('错误规则:'))}`);
      for (const eval_ of errorEvals) {
        rt.lines.push(
          `${rt.indent}  ${this.fmt.yellow(`⚠ ${eval_.rule.id}: ${eval_.message ?? ''}`)}`,
        );
      }
    }
  }

  /** 渲染跳过的规则明细（含跳过原因） */
  private formatSkippedRules(report: RuleEngineReport, rt: RenderTarget): void {
    const skippedEvals = report.evaluations.filter((e) => e.status === 'skipped');
    if (skippedEvals.length > 0) {
      rt.lines.push('');
      rt.lines.push(`${rt.indent}${this.fmt.bold(this.fmt.gray('跳过规则:'))}`);
      for (const eval_ of skippedEvals) {
        rt.lines.push(
          `${rt.indent}  ${this.fmt.gray('-')} ${eval_.rule.id}${eval_.message ? ' — ' + eval_.message : ''}`,
        );
      }
    }
  }

  /** 渲染通过的规则（紧凑模式） */
  private formatPassedRules(report: RuleEngineReport, rt: RenderTarget): void {
    const passedEvals = report.evaluations.filter((e) => e.status === 'passed');
    if (passedEvals.length > 0) {
      rt.lines.push('');
      rt.lines.push(`${rt.indent}${this.fmt.bold('通过规则:')}`);
      for (const eval_ of passedEvals) {
        rt.lines.push(
          `${rt.indent}  ${this.fmt.green('✓')} ${eval_.rule.id}${eval_.message ? ' — ' + eval_.message : ''}`,
        );
      }
    }
  }

  private formatRuleEvaluation(eval_: RuleEvaluation, rt: RenderTarget): void {
    this.formatRuleStatusLine(eval_, rt);
    this.formatRuleMessage(eval_, rt);
    this.formatRuleViolations(eval_, rt);
    this.formatRuleFiles(eval_, rt);
  }

  /** 渲染规则状态图标与规则 ID 行 */
  private formatRuleStatusLine(eval_: RuleEvaluation, rt: RenderTarget): void {
    const statusIcon =
      eval_.status === 'passed'
        ? this.fmt.green('✓')
        : eval_.status === 'failed'
          ? this.fmt.red('✗')
          : eval_.status === 'error'
            ? this.fmt.yellow('⚠')
            : this.fmt.gray('-');

    rt.lines.push(
      `${rt.indent}${statusIcon} ${this.fmt.bold(eval_.rule.id)} (${eval_.rule.severity})`,
    );
  }

  /** 渲染规则消息 */
  private formatRuleMessage(eval_: RuleEvaluation, rt: RenderTarget): void {
    if (eval_.message) {
      rt.lines.push(`${rt.indent}  ${this.fmt.dim(eval_.message)}`);
    }
  }

  /** 渲染违规详情（最多展示 10 条） */
  private formatRuleViolations(eval_: RuleEvaluation, rt: RenderTarget): void {
    if (eval_.violations && eval_.violations.length > 0) {
      const shown = eval_.violations.slice(0, 10);
      for (const v of shown) {
        this.formatViolation(v, rt.lines, `${rt.indent}    `);
      }
      if (eval_.violations.length > 10) {
        rt.lines.push(
          `${rt.indent}    ${this.fmt.dim(`... 及另外 ${eval_.violations.length - 10} 项`)}`,
        );
      }
    }
  }

  /** 渲染涉及文件数量 */
  private formatRuleFiles(eval_: RuleEvaluation, rt: RenderTarget): void {
    if (eval_.files && eval_.files.length > 0) {
      rt.lines.push(`${rt.indent}  ${this.fmt.dim(`涉及文件: ${eval_.files.length} 个`)}`);
    }
  }

  private formatViolation(violation: Violation, lines: string[], indent: string): void {
    const location = violation.line ? `${violation.file}:${violation.line}` : violation.file;
    const locColor =
      violation.severity === 'critical' || violation.severity === 'high'
        ? this.fmt.red(location)
        : this.fmt.yellow(location);

    const catTag = violation.category ? `${this.fmt.magenta(`[${violation.category}]`)} ` : '';
    lines.push(`${indent}${this.fmt.dim('•')} ${locColor}`);
    lines.push(`${indent}  ${catTag}${violation.message}`);
    if (violation.suggestion) {
      lines.push(`${indent}  ${this.fmt.dim('建议:')} ${violation.suggestion}`);
    }
  }
}

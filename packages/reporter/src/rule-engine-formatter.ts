import type { RuleEngineReport, RuleEvaluation, Violation } from '@zh/kernel';
import type { TranslateFn } from './types';
import { ConsoleColor } from './console-color';

interface OutputContext {
  lines: string[];
  indent: string;
}

interface RuleEngineReportContext extends OutputContext {
  report: RuleEngineReport;
}

interface RuleEvaluationContext extends OutputContext {
  evaluation: RuleEvaluation;
}

/**
 * RuleEngineReportFormatter — 将规则引擎报告（SOP 驱动模式）格式化为终端文本行
 *
 * 涵盖：汇总、分类统计、失败/错误/通过规则、违规详情
 */
export class RuleEngineReportFormatter {
  private color: ConsoleColor;
  private tt: TranslateFn;

  constructor(color: ConsoleColor, tt: TranslateFn) {
    this.color = color;
    this.tt = tt;
  }

  format(ctx: RuleEngineReportContext): void {
    this.pushSummary(ctx);
    this.pushCategories(ctx);

    if (ctx.report.total === 0) {
      ctx.lines.push(`${ctx.indent}${this.color.dim(this.tt('reporter.noMatchingRules'))}`);
      return;
    }

    this.pushFailedRules(ctx);
    this.pushErrorRules(ctx);
    this.pushPassedRules(ctx);
  }

  private pushSummary(ctx: RuleEngineReportContext): void {
    const { report, lines, indent } = ctx;
    const total = report.total;
    const passed = report.passed;
    const failed = report.failed;
    const errors = report.errors;
    const skipped = report.skipped;

    lines.push(`${indent}${this.color.bold(this.tt('reporter.summary'))}: ${`${this.color.bold(String(total))} ${this.color.dim(this.tt('reporter.ruleCount', { count: total }))}`}`);
    lines.push(`${indent}  ${this.tt('reporter.passed')}: ${this.color.green(String(passed))}  ${this.tt('reporter.failed')}: ${this.color.red(String(failed))}  ` +
      `${this.tt('reporter.errors')}: ${this.color.yellow(String(errors))}  ${this.tt('reporter.skipped')}: ${this.color.gray(String(skipped))}`);
    lines.push(`${indent}${this.color.dim(this.tt('reporter.duration', { duration: report.durationMs }))}`);
  }

  private pushCategories(ctx: RuleEngineReportContext): void {
    const { report, lines, indent } = ctx;
    // 分类汇总：按 issue category 统计违规数，使各检测维度（security/quality/performance…）可见
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
        .map(([cat, count]) => `${this.color.magenta(cat)} ${this.color.bold(String(count))}`);
      lines.push(`${indent}  ${this.tt('reporter.category')}: ${catParts.join(this.color.dim(', '))}`);
    }
  }

  private pushFailedRules(ctx: RuleEngineReportContext): void {
    const { report, lines, indent } = ctx;
    const failedEvals = report.evaluations.filter((e) => e.status === 'failed');
    if (failedEvals.length === 0) return;

    lines.push('');
    lines.push(`${indent}${this.color.bold(this.color.red(this.tt('reporter.failedRules')))}`);
    for (const eval_ of failedEvals) {
      this.formatRuleEvaluation({ evaluation: eval_, lines, indent: `${indent}  ` });
    }
  }

  private pushErrorRules(ctx: RuleEngineReportContext): void {
    const { report, lines, indent } = ctx;
    const errorEvals = report.evaluations.filter((e) => e.status === 'error');
    if (errorEvals.length === 0) return;

    lines.push('');
    lines.push(`${indent}${this.color.bold(this.color.yellow(this.tt('reporter.errorRules')))}`);
    for (const eval_ of errorEvals) {
      lines.push(`${indent}  ${this.color.yellow(`⚠ ${eval_.rule.id}: ${eval_.message ?? ''}`)}`);
    }
  }

  private pushPassedRules(ctx: RuleEngineReportContext): void {
    const { report, lines, indent } = ctx;
    const passedEvals = report.evaluations.filter((e) => e.status === 'passed');
    if (passedEvals.length === 0) return;

    lines.push('');
    lines.push(`${indent}${this.color.bold(this.tt('reporter.passedRules'))}`);
    for (const eval_ of passedEvals) {
      lines.push(`${indent}  ${this.color.green('✓')} ${eval_.rule.id}${eval_.message ? ' — ' + eval_.message : ''}`);
    }
  }

  private formatRuleEvaluation(ctx: RuleEvaluationContext): void {
    this.pushEvaluationHeader(ctx);
    this.pushEvaluationMessage(ctx);
    this.pushEvaluationViolations(ctx);
    this.pushEvaluationFiles(ctx);
  }

  private pushEvaluationHeader(ctx: RuleEvaluationContext): void {
    const { evaluation, lines, indent } = ctx;
    const statusIcon = evaluation.status === 'passed' ? this.color.green('✓') :
      evaluation.status === 'failed' ? this.color.red('✗') :
      evaluation.status === 'error' ? this.color.yellow('⚠') : this.color.gray('-');

    lines.push(`${indent}${statusIcon} ${this.color.bold(evaluation.rule.id)} (${severityLabel(evaluation.rule.severity, this.tt)})`);
  }

  private pushEvaluationMessage(ctx: RuleEvaluationContext): void {
    const { evaluation, lines, indent } = ctx;
    if (evaluation.message) {
      lines.push(`${indent}  ${this.color.dim(evaluation.message)}`);
    }
  }

  private pushEvaluationViolations(ctx: RuleEvaluationContext): void {
    const { evaluation, lines, indent } = ctx;
    if (!evaluation.violations || evaluation.violations.length === 0) return;

    const shown = evaluation.violations.slice(0, 10);
    for (const v of shown) {
      this.formatViolation(v, lines, `${indent}    `);
    }
    if (evaluation.violations.length > 10) {
      lines.push(`${indent}    ${this.color.dim(this.tt('reporter.andMore', { count: evaluation.violations.length - 10 }))}`);
    }
  }

  private pushEvaluationFiles(ctx: RuleEvaluationContext): void {
    const { evaluation, lines, indent } = ctx;
    if (evaluation.files && evaluation.files.length > 0) {
      lines.push(`${indent}  ${this.color.dim(this.tt('reporter.filesInvolved', { count: evaluation.files.length }))}`);
    }
  }

  private formatViolation(violation: Violation, lines: string[], indent: string): void {
    const location = violation.line
      ? `${violation.file}:${violation.line}`
      : violation.file;
    const locColor = violation.severity === 'critical' || violation.severity === 'high'
      ? this.color.red(location) : this.color.yellow(location);

    const catTag = violation.category ? `${this.color.magenta(`[${violation.category}]`)} ` : '';
    lines.push(`${indent}${this.color.dim('•')} ${locColor}`);
    lines.push(`${indent}  ${catTag}${violation.message}`);
    if (violation.suggestion) {
      lines.push(`${indent}  ${this.color.dim(this.tt('reporter.suggestion'))} ${violation.suggestion}`);
    }
  }
}

const SEVERITY_LABEL_KEYS = new Set(['critical', 'high', 'medium', 'low', 'info']);

/** 将引擎严重度值映射为目录标签（复用种子键 severity.*）；未知值原样返回 */
export function severityLabel(severity: string, tt: TranslateFn): string {
  return SEVERITY_LABEL_KEYS.has(severity) ? tt(`severity.${severity}`) : severity;
}

import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport, RuleEvaluation, Violation } from '@zh/kernel';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { ReportFormatOptions, FormattedReport } from './types';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';
const DIM = '\x1b[2m';

/**
 * ConsoleReporter — 将流水线报告格式化为终端可读的树形文本
 *
 * 支持两种输入格式：
 * - PipelineReport（完整流水线）
 * - RuleEngineReport（SOP 驱动模式）
 */
export class ConsoleReporter {
  private color: boolean;

  constructor(options?: ReportFormatOptions) {
    this.color = options?.color ?? true;
  }

  // ─── 顶层入口 ──────────────────────────────────────────

  /**
   * 格式化 PipelineReport（完整流水线）
   */
  format(report: PipelineReport): FormattedReport {
    const lines: string[] = [];

    lines.push('');
    lines.push(this.header('智汇码盾 — 代码质量管理报告'));
    lines.push(this.dim(`时间: ${report.timestamp.toISOString()}`));
    lines.push(this.dim(`状态: ${report.passed ? '✅ 通过' : '❌ 失败'}`));
    lines.push(this.dim(`阶段: ${report.stage}`));
    if (report.error) {
      lines.push(this.red(`错误: ${report.error}`));
    }
    lines.push('');

    // Guard 阶段
    lines.push(this.color ? `${BOLD}Guard 门禁检查${RESET}` : 'Guard 门禁检查');
    if (report.guard === null) {
      lines.push(this.dim('  (未执行)'));
    } else if (this.isRuleEngineReport(report.guard)) {
      this.formatRuleEngineReport(report.guard, lines, '  ');
    } else {
      this.formatGuardReport(report.guard, lines, '  ');
    }
    lines.push('');

    // Inspect 阶段
    lines.push(this.color ? `${BOLD}Inspect 巡检${RESET}` : 'Inspect 巡检');
    if (report.inspect === null) {
      lines.push(this.dim('  (未执行)'));
    } else if (this.isRuleEngineReport(report.inspect)) {
      this.formatRuleEngineReport(report.inspect, lines, '  ');
    } else {
      this.formatInspectReport(report.inspect, lines, '  ');
    }
    lines.push('');

    lines.push(this.color ? `${BOLD}Refactor 重构检测${RESET}` : 'Refactor 重构检测');
    if (report.refactor == null) {
      lines.push(this.dim('  (未执行)'));
    } else {
      this.formatRefactorReport(report.refactor, lines, '  ');
    }
    lines.push('');

    // 结论
    const verdict = report.passed ? this.green('✓ 流水线通过') : this.red('✗ 流水线失败');
    lines.push(this.header(verdict));
    lines.push('');

    return {
      text: lines.join('\n'),
      passed: report.passed,
    };
  }

  /**
   * 格式化 RuleEngineReport（SOP 驱动模式）
   */
  formatRuleEngine(report: RuleEngineReport): FormattedReport {
    const lines: string[] = [];
    lines.push('');
    lines.push(this.header('SOP 规则引擎报告'));
    this.formatRuleEngineReport(report, lines, '');
    lines.push('');

    const passed = report.ok;
    const verdict = passed ? this.green('✓ 引擎检查通过') : this.red('✗ 引擎检查失败');
    lines.push(this.header(verdict));
    lines.push('');

    return { text: lines.join('\n'), passed };
  }

  // ─── 内部格式化 ──────────────────────────────────────

  private formatRuleEngineReport(report: RuleEngineReport, lines: string[], indent: string): void {
    const total = report.total;
    const passed = report.passed;
    const failed = report.failed;
    const errors = report.errors;
    const skipped = report.skipped;

    lines.push(`${indent}${this.bold('汇总')}: ${`${this.bold(String(total))} ${this.dim('条规则')}`}`);
    lines.push(`${indent}  通过: ${this.green(String(passed))}  失败: ${this.red(String(failed))}  ` +
      `错误: ${this.yellow(String(errors))}  跳过: ${this.gray(String(skipped))}`);

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
        .map(([cat, count]) => `${this.magenta(cat)} ${this.bold(String(count))}`);
      lines.push(`${indent}  分类: ${catParts.join(this.dim(', '))}`);
    }

    lines.push(`${indent}${this.dim(`耗时: ${report.durationMs}ms`)}`);

    if (total === 0) {
      lines.push(`${indent}${this.dim('(无匹配规则)')}`);
      return;
    }

    // 失败的规则详情
    const failedEvals = report.evaluations.filter((e) => e.status === 'failed');
    if (failedEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.bold(this.red('失败规则:'))}`);
      for (const eval_ of failedEvals) {
        this.formatRuleEvaluation(eval_, lines, `${indent}  `);
      }
    }

    // 错误规则
    const errorEvals = report.evaluations.filter((e) => e.status === 'error');
    if (errorEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.bold(this.yellow('错误规则:'))}`);
      for (const eval_ of errorEvals) {
        lines.push(`${indent}  ${this.yellow(`⚠ ${eval_.rule.id}: ${eval_.message ?? ''}`)}`);
      }
    }

    // 通过的规则（紧凑模式）
    const passedEvals = report.evaluations.filter((e) => e.status === 'passed');
    if (passedEvals.length > 0) {
      lines.push('');
      lines.push(`${indent}${this.bold('通过规则:')}`);
      for (const eval_ of passedEvals) {
        lines.push(`${indent}  ${this.green('✓')} ${eval_.rule.id}${eval_.message ? ' — ' + eval_.message : ''}`);
      }
    }
  }

  private formatRuleEvaluation(eval_: RuleEvaluation, lines: string[], indent: string): void {
    const statusIcon = eval_.status === 'passed' ? this.green('✓') :
      eval_.status === 'failed' ? this.red('✗') :
      eval_.status === 'error' ? this.yellow('⚠') : this.gray('-');

    lines.push(`${indent}${statusIcon} ${this.bold(eval_.rule.id)} (${eval_.rule.severity})`);

    if (eval_.message) {
      lines.push(`${indent}  ${this.dim(eval_.message)}`);
    }

    // 违规详情
    if (eval_.violations && eval_.violations.length > 0) {
      const shown = eval_.violations.slice(0, 10);
      for (const v of shown) {
        this.formatViolation(v, lines, `${indent}    `);
      }
      if (eval_.violations.length > 10) {
        lines.push(`${indent}    ${this.dim(`... 及另外 ${eval_.violations.length - 10} 项`)}`);
      }
    }

    // 文件列表
    if (eval_.files && eval_.files.length > 0) {
      lines.push(`${indent}  ${this.dim(`涉及文件: ${eval_.files.length} 个`)}`);
    }
  }

  private formatViolation(violation: Violation, lines: string[], indent: string): void {
    const location = violation.line
      ? `${violation.file}:${violation.line}`
      : violation.file;
    const locColor = violation.severity === 'critical' || violation.severity === 'high'
      ? this.red(location) : this.yellow(location);

    const catTag = violation.category ? `${this.magenta(`[${violation.category}]`)} ` : '';
    lines.push(`${indent}${this.dim('•')} ${locColor}`);
    lines.push(`${indent}  ${catTag}${violation.message}`);
    if (violation.suggestion) {
      lines.push(`${indent}  ${this.dim('建议:')} ${violation.suggestion}`);
    }
  }

  private formatGuardReport(report: GuardReport, lines: string[], indent: string): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;
    const passed = summary?.passed ?? 0;
    const failed = summary?.failed ?? 0;

    lines.push(`${indent}${this.bold('汇总')}: ${`${this.bold(String(total))} ${this.dim('项检查')}`}`);
    lines.push(`${indent}  通过: ${this.green(String(passed))}  失败: ${this.red(String(failed))}`);
    lines.push(`${indent}${this.dim(`阻断: ${report.ok === false ? '是' : report.ok === null ? '干运行' : '否'}`)}`);
  }

  private formatRefactorReport(report: RefactorReport, lines: string[], indent: string): void {
    formatRefactorReportBody(report, lines, indent, {
      bold: (s) => this.bold(s), dim: (s) => this.dim(s), red: (s) => this.red(s),
      green: (s) => this.green(s), yellow: (s) => this.yellow(s), gray: (s) => this.gray(s),
    });
  }

  private formatInspectReport(report: InspectionReport, lines: string[], indent: string): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;

    lines.push(`${indent}${this.bold('汇总')}: ${`${this.bold(String(total))} ${this.dim('个问题')}`}`);
    lines.push(`${indent}  Error: ${this.red(String(summary?.error ?? 0))}  ` +
      `Warning: ${this.yellow(String(summary?.warning ?? 0))}  ` +
      `Info: ${this.gray(String(summary?.info ?? 0))}`);

    if (report.score) {
      const gradeS = report.score.grade === 'A' ? this.green(report.score.grade) :
        report.score.grade === 'B' ? this.yellow(report.score.grade) : this.red(report.score.grade);
      lines.push(`${indent}${this.dim(`评分: ${this.bold(String(report.score.overall))} (${gradeS})`)}`);
    }
  }

  // ─── 类型守卫 ─────────────────────────────────────────

  private isRuleEngineReport(r: unknown): r is RuleEngineReport {
    return typeof r === 'object' && r !== null && 'evaluations' in r && 'ok' in r && 'total' in r;
  }

  // ─── 颜色工具 ─────────────────────────────────────────

  private bold(s: string): string {
    return this.color ? `${BOLD}${s}${RESET}` : s;
  }

  private red(s: string): string {
    return this.color ? `${RED}${s}${RESET}` : s;
  }

  private green(s: string): string {
    return this.color ? `${GREEN}${s}${RESET}` : s;
  }

  private yellow(s: string): string {
    return this.color ? `${YELLOW}${s}${RESET}` : s;
  }

  private cyan(s: string): string {
    return this.color ? `${CYAN}${s}${RESET}` : s;
  }

  private magenta(s: string): string {
    return this.color ? `${MAGENTA}${s}${RESET}` : s;
  }

  private gray(s: string): string {
    return this.color ? `${GRAY}${s}${RESET}` : s;
  }

  private dim(s: string): string {
    return this.color ? `${DIM}${s}${RESET}` : s;
  }

  private header(text: string): string {
    return this.color ? `${BOLD}${CYAN}${text}${RESET}` : `== ${text} ==`;
  }
}

interface ColorTools {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  gray(s: string): string;
}

function formatRefactorReportBody(report: RefactorReport, lines: string[], indent: string, c: ColorTools): void {
  formatRefactorSummary(report, lines, indent, c);

  if (report.totalSmells === 0) return;

  formatSeverityBreakdown(report, lines, indent, c);
  formatCategoryBreakdown(report, lines, indent, c);
  formatCriticalFlags(report, lines, indent, c);
  formatCriticalFiles(report, lines, indent, c);
}

function formatRefactorSummary(report: RefactorReport, lines: string[], indent: string, c: ColorTools): void {
  const total = report.totalSmells;
  const files = report.totalFiles;
  const scanned = report.scannedFiles;

  lines.push(`${indent}${c.bold('汇总')}: ${`${c.bold(String(total))} ${c.dim('个代码异味')}`}`);
  lines.push(`${indent}  扫描: ${c.gray(`${scanned}/${files} 文件`)}`);
  lines.push(`${indent}  ${c.dim(`时间: ${report.timestamp}`)}`);

  if (total === 0) {
    lines.push(`${indent}${c.green('✓ 未检测到代码异味')}`);
  }
}

function formatSeverityBreakdown(report: RefactorReport, lines: string[], indent: string, c: ColorTools): void {
  const sevParts: string[] = [];
  for (const [sev, count] of Object.entries(report.bySeverity)) {
    if (count === 0) continue;
    const colorFn = sev === 'error' || sev === 'critical'
      ? (s: string) => c.red(s)
      : sev === 'warning'
        ? (s: string) => c.yellow(s)
        : (s: string) => c.gray(s);
    sevParts.push(`${colorFn(String(count))}${c.dim(` ${sev}`)}`);
  }
  if (sevParts.length > 0) {
    lines.push(`${indent}  严重度: ${sevParts.join(', ')}`);
  }
}

function formatCategoryBreakdown(report: RefactorReport, lines: string[], indent: string, c: ColorTools): void {
  if (Object.keys(report.byCategory).length === 0) return;

  const catParts = Object.entries(report.byCategory)
    .filter(([, c2]) => c2 > 0)
    .map(([cat, count]) => `${c.dim(cat)} ${c.bold(String(count))}`);
  if (catParts.length > 0) {
    lines.push(`${indent}  分类: ${catParts.join(', ')}`);
  }
}

function formatCriticalFlags(report: RefactorReport, lines: string[], indent: string, c: ColorTools): void {
  if (report.summary.criticalFiles > 0) {
    lines.push(`${indent}${c.red(`高危文件: ${report.summary.criticalFiles}`)}`);
  }
  if (report.summary.needsImmediateAction > 0) {
    lines.push(`${indent}${c.yellow(`需立即处理: ${report.summary.needsImmediateAction}`)}`);
  }
}

function formatCriticalFiles(report: RefactorReport, lines: string[], indent: string, c: ColorTools): void {
  const criticalFiles = report.files.filter(f => f.refactorPriority === 'critical' || f.refactorPriority === 'high');
  if (criticalFiles.length === 0) return;

  lines.push('');
  lines.push(`${indent}${c.bold(c.red('需关注的文件:'))}`);
  for (const file of criticalFiles.slice(0, 10)) {
    const priorityColor = file.refactorPriority === 'critical'
      ? (s: string) => c.red(s)
      : (s: string) => c.yellow(s);
    lines.push(`${indent}  ${priorityColor('•')} ${c.dim(file.filePath)}`);
    lines.push(`${indent}    ${c.dim(`${file.totalSmells} 个异味, 可维护性评分: ${file.maintainabilityScore}`)}`);
    for (const smell of file.smells.slice(0, 3)) {
      const sColor = smell.severity === 'error'
        ? (s: string) => c.red(s)
        : (s: string) => c.yellow(s);
      lines.push(`${indent}    ${sColor('·')} [${smell.ruleId}] ${smell.message}${smell.location.line ? ` (行 ${smell.location.line})` : ''}`);
    }
    if (file.smells.length > 3) {
      lines.push(`${indent}      ${c.dim(`... 及另外 ${file.smells.length - 3} 项`)}`);
    }
  }
}

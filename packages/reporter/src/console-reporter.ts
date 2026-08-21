import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport } from '@zh/kernel';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import { t, translate, type LanguageCode } from '@zh/i18n';
import type { ReportFormatOptions, FormattedReport, TranslateFn } from './types';
import { ConsoleColor } from './console-color';
import { RuleEngineReportFormatter, severityLabel } from './rule-engine-formatter';

/**
 * ConsoleReporter — 将流水线报告格式化为终端可读的树形文本
 *
 * 支持两种输入格式：
 * - PipelineReport（完整流水线）
 * - RuleEngineReport（SOP 驱动模式）
 *
 * 职责划分：颜色工具见 ConsoleColor，规则引擎报告渲染见 RuleEngineReportFormatter
 */
export class ConsoleReporter {
  private color: ConsoleColor;
  private ruleEngineFormatter: RuleEngineReportFormatter;
  private lang?: LanguageCode;

  constructor(options?: ReportFormatOptions) {
    this.color = new ConsoleColor(options?.color ?? true);
    this.lang = options?.lang;
    this.ruleEngineFormatter = new RuleEngineReportFormatter(this.color, (key, params) => this.tt(key, params));
  }

  /** 按选项语言（显式 translate）或进程级单例当前语言（t）翻译 */
  private tt(key: string, params?: Record<string, unknown>): string {
    return this.lang ? translate(key, this.lang, params) : t(key, params);
  }

  // ─── 顶层入口 ──────────────────────────────────────────

  /**
   * 格式化 PipelineReport（完整流水线）
   */
  format(report: PipelineReport): FormattedReport {
    const lines: string[] = [];

    this.pushReportHeader(lines, report);
    this.pushProfileSection(lines, report);
    this.pushGuardSection(lines, report);
    this.pushInspectSection(lines, report);
    this.pushSecuritySection(lines, report);
    this.pushScoreSection(lines, report);
    this.pushRefactorSection(lines, report);
    this.pushVerdict(lines, report);

    return {
      text: lines.join('\n'),
      passed: report.passed,
    };
  }

  private pushProfileSection(lines: string[], report: PipelineReport): void {
    lines.push(this.color.bold(this.tt('reporter.profileTitle')));
    if (report.profile == null) {
      lines.push(this.color.dim(this.tt('reporter.notExecuted')));
    } else {
      const { profile } = report;
      const framework = profile.framework ? ` / ${profile.framework}` : '';
      lines.push(`  ${this.color.bold(profile.language)}${framework}${this.color.dim(` / ${profile.packageManager}`)}`);
    }
    lines.push('');
  }

  private pushReportHeader(lines: string[], report: PipelineReport): void {
    lines.push(
      '',
      this.color.header(this.tt('reporter.reportTitle')),
      this.color.dim(this.tt('reporter.timestamp', { timestamp: report.timestamp.toISOString() })),
      this.color.dim(this.tt('reporter.status', { status: report.passed ? this.tt('reporter.statusPassed') : this.tt('reporter.statusFailed') })),
      this.color.dim(this.tt('reporter.stage', { stage: report.stage })),
    );
    if (report.error) {
      lines.push(this.color.red(this.tt('reporter.error', { error: report.error })));
    }
    lines.push('');
  }

  private pushGuardSection(lines: string[], report: PipelineReport): void {
    lines.push(this.color.bold(this.tt('reporter.guardSection')));
    if (report.guard === null) {
      lines.push(this.color.dim(this.tt('reporter.notExecuted')));
    } else if (this.isRuleEngineReport(report.guard)) {
      this.ruleEngineFormatter.format({ report: report.guard, lines, indent: '  ' });
    } else {
      this.formatGuardReport(report.guard, lines, '  ');
    }
    lines.push('');
  }

  private pushInspectSection(lines: string[], report: PipelineReport): void {
    lines.push(this.color.bold(this.tt('reporter.inspectSection')));
    if (report.inspect === null) {
      lines.push(this.color.dim(this.tt('reporter.notExecuted')));
    } else if (this.isRuleEngineReport(report.inspect)) {
      this.ruleEngineFormatter.format({ report: report.inspect, lines, indent: '  ' });
    } else {
      this.formatInspectReport(report.inspect, lines, '  ');
    }
    lines.push('');
  }

  private pushSecuritySection(lines: string[], report: PipelineReport): void {
    lines.push(this.color.bold(this.tt('reporter.securitySection')));
    if (report.security == null) {
      lines.push(this.color.dim(this.tt('reporter.notExecuted')));
    } else {
      const s = report.security.summary;
      const score = report.security.securityScore;
      const scoreColor = score >= 90 ? this.color.green(String(score))
        : score >= 60 ? this.color.yellow(String(score))
        : this.color.red(String(score));
      lines.push(`  ${this.color.dim(this.tt('reporter.securityScore'))}: ${this.color.bold(scoreColor)}`);
      lines.push(
        `  ${this.color.dim(this.tt('reporter.vulnerabilities'))}: ${this.color.red(String(s.vulnTotal))}  ` +
        `${this.color.dim('(')}` +
        `${this.color.red(String(s.vulnCritical))}${this.color.dim(` ${this.tt('severity.critical')}, `)}` +
        `${this.color.red(String(s.vulnHigh))}${this.color.dim(` ${this.tt('severity.high')}, `)}` +
        `${this.color.yellow(String(s.vulnMedium))}${this.color.dim(` ${this.tt('severity.medium')}, `)}` +
        `${this.color.gray(String(s.vulnLow))}${this.color.dim(` ${this.tt('severity.low')})`)}  ` +
        `${this.color.dim(this.tt('reporter.malware'))}: ${this.color.red(String(s.malwareTotal))}  ` +
        `${this.color.dim(this.tt('reporter.garbage'))}: ${this.color.yellow(String(s.garbageTotal))}`,
      );
    }
    lines.push('');
  }

  private pushScoreSection(lines: string[], report: PipelineReport): void {
    lines.push(this.color.bold(this.tt('reporter.scoreSection')));
    if (report.score == null) {
      lines.push(this.color.dim(this.tt('reporter.notCalculated')));
    } else {
      const score = report.score;
      const overall = score.overall;
      const gradeS = overall >= 90 ? this.color.green(score.grade)
        : overall >= 75 ? this.color.yellow(score.grade)
        : this.color.red(score.grade);
      lines.push(`  ${this.color.dim(this.tt('reporter.overall'))}: ${this.color.bold(String(overall))} (${gradeS})`);
      for (const dim of score.dimensions) {
        const dimColor = dim.score >= 90 ? this.color.green(String(dim.score))
          : dim.score >= 75 ? this.color.yellow(String(dim.score))
          : this.color.red(String(dim.score));
        lines.push(`  ${this.color.dim(`${dim.name}`)}: ${dimColor}${this.color.dim(` ${this.tt('reporter.issuesCount', { count: dim.issues })}`)}`);
      }
    }
    lines.push('');
  }

  private pushRefactorSection(lines: string[], report: PipelineReport): void {
    lines.push(this.color.bold(this.tt('reporter.refactorSection')));
    if (report.refactor == null) {
      lines.push(this.color.dim(this.tt('reporter.notExecuted')));
    } else {
      this.formatRefactorReport(report.refactor, lines, '  ');
    }
    lines.push('');
  }

  private pushVerdict(lines: string[], report: PipelineReport): void {
    const verdict = report.passed ? this.color.green(this.tt('reporter.pipelinePassed')) : this.color.red(this.tt('reporter.pipelineFailed'));
    lines.push(this.color.header(verdict));
    lines.push('');
  }

  /**
   * 格式化 RuleEngineReport（SOP 驱动模式）
   */
  formatRuleEngine(report: RuleEngineReport): FormattedReport {
    const lines: string[] = [];
    lines.push('');
    lines.push(this.color.header(this.tt('reporter.ruleEngineTitle')));
    this.ruleEngineFormatter.format({ report, lines, indent: '' });
    lines.push('');

    const passed = report.ok !== false;
    const verdict = report.ok === null
      ? this.color.yellow(this.tt('reporter.engineDryRun'))
      : passed ? this.color.green(this.tt('reporter.enginePassed')) : this.color.red(this.tt('reporter.engineFailed'));
    lines.push(this.color.header(verdict));
    lines.push('');

    return { text: lines.join('\n'), passed };
  }

  // ─── 各阶段报告格式化 ────────────────────────────────

  private formatGuardReport(report: GuardReport, lines: string[], indent: string): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;
    const passed = summary?.passed ?? 0;
    const failed = summary?.failed ?? 0;

    lines.push(`${indent}${this.color.bold(this.tt('reporter.summary'))}: ${`${this.color.bold(String(total))} ${this.color.dim(this.tt('reporter.checkCount', { count: total }))}`}`);
    lines.push(`${indent}  ${this.tt('reporter.passed')}: ${this.color.green(String(passed))}  ${this.tt('reporter.failed')}: ${this.color.red(String(failed))}`);
    lines.push(`${indent}${this.color.dim(this.tt('reporter.blocking', { value: this.blockingValue(report.ok) }))}`);
  }

  private blockingValue(ok: boolean | null | undefined): string {
    return ok === false ? this.tt('reporter.blockingYes') : ok === null ? this.tt('reporter.blockingDryRun') : this.tt('reporter.blockingNo');
  }

  private formatRefactorReport(report: RefactorReport, lines: string[], indent: string): void {
    formatRefactorReportBody(report, lines, indent, this.color, (key, params) => this.tt(key, params));
  }

  private formatInspectReport(report: InspectionReport, lines: string[], indent: string): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;

    lines.push(`${indent}${this.color.bold(this.tt('reporter.summary'))}: ${`${this.color.bold(String(total))} ${this.color.dim(this.tt('reporter.issueCount', { count: total }))}`}`);
    lines.push(`${indent}  Error: ${this.color.red(String(summary?.error ?? 0))}  ` +
      `Warning: ${this.color.yellow(String(summary?.warning ?? 0))}  ` +
      `Info: ${this.color.gray(String(summary?.info ?? 0))}`);

    if (report.score) {
      const gradeS = report.score.grade === 'A' ? this.color.green(report.score.grade) :
        report.score.grade === 'B' ? this.color.yellow(report.score.grade) : this.color.red(report.score.grade);
      lines.push(`${indent}${this.color.dim(this.tt('reporter.score', { score: String(report.score.overall), grade: gradeS }))}`);
    }
  }

  // ─── 类型守卫 ─────────────────────────────────────────

  private isRuleEngineReport(r: unknown): r is RuleEngineReport {
    return typeof r === 'object' && r !== null && 'evaluations' in r && 'ok' in r && 'total' in r;
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

function formatRefactorReportBody(report: RefactorReport, lines: string[], indent: string, c: ColorTools, tt: TranslateFn): void {
  formatRefactorSummary(report, lines, indent, c, tt);

  if (report.totalSmells === 0) return;

  formatSeverityBreakdown(report, lines, indent, c, tt);
  formatCategoryBreakdown(report, lines, indent, c, tt);
  formatCriticalFlags(report, lines, indent, c, tt);
  formatCriticalFiles(report, lines, indent, c, tt);
}

function formatRefactorSummary(report: RefactorReport, lines: string[], indent: string, c: ColorTools, tt: TranslateFn): void {
  const total = report.totalSmells;
  const files = report.totalFiles;
  const scanned = report.scannedFiles;

  lines.push(`${indent}${c.bold(tt('reporter.summary'))}: ${`${c.bold(String(total))} ${c.dim(tt('reporter.smellCount', { count: total }))}`}`);
  lines.push(`${indent}  ${c.gray(tt('reporter.scanCount', { scanned, files }))}`);
  lines.push(`${indent}  ${c.dim(tt('reporter.time', { timestamp: report.timestamp }))}`);

  if (total === 0) {
    lines.push(`${indent}${c.green(tt('reporter.noSmells'))}`);
  }
}

function formatSeverityBreakdown(report: RefactorReport, lines: string[], indent: string, c: ColorTools, tt: TranslateFn): void {
  const sevParts: string[] = [];
  for (const [sev, count] of Object.entries(report.bySeverity)) {
    if (count === 0) continue;
    const colorFn = sev === 'error' || sev === 'critical'
      ? (s: string) => c.red(s)
      : sev === 'warning'
        ? (s: string) => c.yellow(s)
        : (s: string) => c.gray(s);
    sevParts.push(`${colorFn(String(count))}${c.dim(` ${severityLabel(sev, tt)}`)}`);
  }
  if (sevParts.length > 0) {
    lines.push(`${indent}  ${tt('reporter.severity')}: ${sevParts.join(', ')}`);
  }
}

function formatCategoryBreakdown(report: RefactorReport, lines: string[], indent: string, c: ColorTools, tt: TranslateFn): void {
  if (Object.keys(report.byCategory).length === 0) return;

  const catParts = Object.entries(report.byCategory)
    .filter(([, c2]) => c2 > 0)
    .map(([cat, count]) => `${c.dim(cat)} ${c.bold(String(count))}`);
  if (catParts.length > 0) {
    lines.push(`${indent}  ${tt('reporter.category')}: ${catParts.join(', ')}`);
  }
}

function formatCriticalFlags(report: RefactorReport, lines: string[], indent: string, c: ColorTools, tt: TranslateFn): void {
  if (report.summary.criticalFiles > 0) {
    lines.push(`${indent}${c.red(tt('reporter.criticalFiles', { count: report.summary.criticalFiles }))}`);
  }
  if (report.summary.needsImmediateAction > 0) {
    lines.push(`${indent}${c.yellow(tt('reporter.needsImmediateAction', { count: report.summary.needsImmediateAction }))}`);
  }
}

function formatCriticalFiles(report: RefactorReport, lines: string[], indent: string, c: ColorTools, tt: TranslateFn): void {
  const criticalFiles = report.files.filter(f => f.refactorPriority === 'critical' || f.refactorPriority === 'high');
  if (criticalFiles.length === 0) return;

  lines.push('');
  lines.push(`${indent}${c.bold(c.red(tt('reporter.criticalFilesTitle')))}`);
  for (const file of criticalFiles.slice(0, 10)) {
    const priorityColor = file.refactorPriority === 'critical'
      ? (s: string) => c.red(s)
      : (s: string) => c.yellow(s);
    lines.push(`${indent}  ${priorityColor('•')} ${c.dim(file.filePath)}`);
    lines.push(`${indent}    ${c.dim(tt('reporter.smellSummary', { count: file.totalSmells, score: file.maintainabilityScore }))}`);
    for (const smell of file.smells.slice(0, 3)) {
      const sColor = smell.severity === 'error'
        ? (s: string) => c.red(s)
        : (s: string) => c.yellow(s);
      lines.push(`${indent}    ${sColor('·')} [${smell.ruleId}] ${smell.message}${smell.location.line ? ` ${tt('reporter.line', { line: smell.location.line })}` : ''}`);
    }
    if (file.smells.length > 3) {
      lines.push(`${indent}      ${c.dim(tt('reporter.andMore', { count: file.smells.length - 3 }))}`);
    }
  }
}

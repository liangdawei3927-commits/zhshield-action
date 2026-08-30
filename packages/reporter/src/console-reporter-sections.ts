import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport } from '@zh/kernel';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { ConsoleReporterFormat } from './console-reporter-format';
import type { RuleEngineSectionFormatter } from './console-reporter-rule-engine';

/**
 * StageSectionFormatter — 渲染流水线各阶段（Guard / Inspect / Refactor）的文本段落
 *
 * 从 ConsoleReporter 拆分而来，职责单一：各阶段门禁/巡检/重构检测的汇总渲染，
 * 以及 RuleEngineReport 与 GuardReport/InspectionReport 的类型判别。
 */
export class StageSectionFormatter {
  private fmt: ConsoleReporterFormat;
  private ruleEngine: RuleEngineSectionFormatter;

  constructor(fmt: ConsoleReporterFormat, ruleEngine: RuleEngineSectionFormatter) {
    this.fmt = fmt;
    this.ruleEngine = ruleEngine;
  }

  /** 渲染 Guard 门禁检查阶段 */
  formatGuardStage(report: PipelineReport, lines: string[]): void {
    lines.push(this.fmt.color ? `${BOLD}Guard 门禁检查${RESET}` : 'Guard 门禁检查');
    if (report.guard === null) {
      lines.push(this.fmt.dim('  (未执行)'));
    } else if (this.isRuleEngineReport(report.guard)) {
      this.ruleEngine.format(report.guard, lines, '  ');
    } else {
      this.formatGuardReport(report.guard, lines, '  ');
    }
    lines.push('');
  }

  /** 渲染 Inspect 巡检阶段 */
  formatInspectStage(report: PipelineReport, lines: string[]): void {
    lines.push(this.fmt.color ? `${BOLD}Inspect 巡检${RESET}` : 'Inspect 巡检');
    if (report.inspect === null) {
      lines.push(this.fmt.dim('  (未执行)'));
    } else if (this.isRuleEngineReport(report.inspect)) {
      this.ruleEngine.format(report.inspect, lines, '  ');
    } else {
      this.formatInspectReport(report.inspect, lines, '  ');
    }
    lines.push('');
  }

  /** 渲染 Refactor 重构检测阶段 */
  formatRefactorStage(report: PipelineReport, lines: string[]): void {
    lines.push(this.fmt.color ? `${BOLD}Refactor 重构检测${RESET}` : 'Refactor 重构检测');
    if (report.refactor == null) {
      lines.push(this.fmt.dim('  (未执行)'));
    } else {
      this.formatRefactorReport(report.refactor, lines, '  ');
    }
    lines.push('');
  }

  private formatGuardReport(report: GuardReport, lines: string[], indent: string): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;
    const passed = summary?.passed ?? 0;
    const failed = summary?.failed ?? 0;

    lines.push(`${indent}${this.fmt.bold('汇总')}: ${`${this.fmt.bold(String(total))} ${this.fmt.dim('项检查')}`}`);
    lines.push(`${indent}  通过: ${this.fmt.green(String(passed))}  失败: ${this.fmt.red(String(failed))}`);
    lines.push(`${indent}${this.fmt.dim(`阻断: ${report.ok === false ? '是' : report.ok === null ? '干运行' : '否'}`)}`);
  }

  private formatRefactorReport(report: RefactorReport, lines: string[], indent: string): void {
    formatRefactorReportBody(report, lines, indent, {
      bold: (s) => this.fmt.bold(s), dim: (s) => this.fmt.dim(s), red: (s) => this.fmt.red(s),
      green: (s) => this.fmt.green(s), yellow: (s) => this.fmt.yellow(s), gray: (s) => this.fmt.gray(s),
    });
  }

  private formatInspectReport(report: InspectionReport, lines: string[], indent: string): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;

    lines.push(`${indent}${this.fmt.bold('汇总')}: ${`${this.fmt.bold(String(total))} ${this.fmt.dim('个问题')}`}`);
    lines.push(`${indent}  Error: ${this.fmt.red(String(summary?.error ?? 0))}  ` +
      `Warning: ${this.fmt.yellow(String(summary?.warning ?? 0))}  ` +
      `Info: ${this.fmt.gray(String(summary?.info ?? 0))}`);

    if (report.score) {
      const gradeS = report.score.grade === 'A' ? this.fmt.green(report.score.grade) :
        report.score.grade === 'B' ? this.fmt.yellow(report.score.grade) : this.fmt.red(report.score.grade);
      lines.push(`${indent}${this.fmt.dim(`评分: ${this.fmt.bold(String(report.score.overall))} (${gradeS})`)}`);
    }

    this.formatToolAvailability(report, lines, indent);
  }

  /** 渲染工具可用性矩阵：显式上报每个外部扫描工具的可用状态，消除"工具缺失静默跳过"盲区 */
  private formatToolAvailability(report: InspectionReport, lines: string[], indent: string): void {
    const results = report.adapterResults;
    if (!results || results.length === 0) return;

    const unavailable = results.filter(r => r.status === 'unavailable');
    const errors = results.filter(r => r.status === 'error' || r.status === 'failed');
    const skipped = results.filter(r => r.status === 'skipped');
    const normal = results.filter(r => r.status === 'passed' || r.status === undefined);

    if (unavailable.length === 0 && errors.length === 0 && skipped.length === 0) {
      const parts = normal.map(r =>
        `${this.fmt.dim(r.adapterName)}${r.duration > 0 ? this.fmt.dim(`(${(r.duration / 1000).toFixed(1)}s)`) : ''}`
      );
      lines.push(`${indent}${this.fmt.dim('工具')}: ${parts.join('  ')}`);
      return;
    }

    if (unavailable.length > 0) {
      const names = unavailable.map(r => this.fmt.yellow(r.adapterName)).join('、');
      lines.push(`${indent}${this.fmt.yellow('⚠ 工具不可用')}: ${names}（未安装，可用 zhshield tools install 安装）`);
    }

    if (errors.length > 0) {
      const names = errors.map(r => this.fmt.red(r.adapterName)).join('、');
      lines.push(`${indent}${this.fmt.red('✗ 工具执行失败')}: ${names} (错误详情已在 issues 中)`);
    }

    if (skipped.length > 0) {
      const names = skipped.map(r => this.fmt.gray(r.adapterName)).join('、');
      lines.push(`${indent}${this.fmt.gray('- 已跳过')}: ${names}（语言不适用）`);
    }

    if (normal.length > 0) {
      const parts = normal.map(r =>
        `${this.fmt.dim(r.adapterName)}${r.duration > 0 ? this.fmt.dim(`(${(r.duration / 1000).toFixed(1)}s)`) : ''}`
      );
      lines.push(`${indent}${this.fmt.dim('工具')}: ${parts.join('  ')}`);
    }
  }

  private isRuleEngineReport(r: unknown): r is RuleEngineReport {
    return typeof r === 'object' && r !== null && 'evaluations' in r && 'ok' in r && 'total' in r;
  }
}

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

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

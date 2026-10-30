import type { PipelineReport } from '@zh/pipeline';
import type { RuleEngineReport } from '@zh/kernel';
import type { GuardReport } from '@zh/guard';
import type { AdapterResult, InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { ConsoleReporterFormat, RenderTarget } from './console-reporter-format';
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
      this.formatInspectReport(report.inspect, { lines, indent: '  ' });
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

    lines.push(
      `${indent}${this.fmt.bold('汇总')}: ${`${this.fmt.bold(String(total))} ${this.fmt.dim('项检查')}`}`,
    );
    lines.push(
      `${indent}  通过: ${this.fmt.green(String(passed))}  失败: ${this.fmt.red(String(failed))}`,
    );
    // 跳过（让位/降级）既不是通过也不是失败：不写出来，用户会以为「通过+失败 ≠ 总数」是算错
    const skipped = summary?.skipped ?? 0;
    if (skipped > 0) {
      lines.push(`${indent}  ${this.fmt.dim(`跳过（未在本阶段执行）: ${skipped}`)}`);
    }
    lines.push(
      `${indent}${this.fmt.dim(`阻断: ${report.ok === false ? '是' : report.ok === null ? '干运行' : '否'}`)}`,
    );
  }

  private formatRefactorReport(report: RefactorReport, lines: string[], indent: string): void {
    formatRefactorReportBody(report, lines, indent, {
      bold: (s) => this.fmt.bold(s),
      dim: (s) => this.fmt.dim(s),
      red: (s) => this.fmt.red(s),
      green: (s) => this.fmt.green(s),
      yellow: (s) => this.fmt.yellow(s),
      gray: (s) => this.fmt.gray(s),
    });
  }

  private formatInspectReport(report: InspectionReport, rt: RenderTarget): void {
    const summary = report.summary;
    const total = summary?.total ?? 0;

    rt.lines.push(
      `${rt.indent}${this.fmt.bold('汇总')}: ${`${this.fmt.bold(String(total))} ${this.fmt.dim('个问题')}`}`,
    );
    rt.lines.push(
      `${rt.indent}  Error: ${this.fmt.red(String(summary?.error ?? 0))}  ` +
        `Warning: ${this.fmt.yellow(String(summary?.warning ?? 0))}  ` +
        `Info: ${this.fmt.gray(String(summary?.info ?? 0))}`,
    );

    if (report.score) {
      const gradeS =
        report.score.grade === 'A'
          ? this.fmt.green(report.score.grade)
          : report.score.grade === 'B'
            ? this.fmt.yellow(report.score.grade)
            : this.fmt.red(report.score.grade);
      rt.lines.push(
        `${rt.indent}${this.fmt.dim(`评分: ${this.fmt.bold(String(report.score.overall))} (${gradeS})`)}`,
      );
    }

    this.formatSuppressedIssues(report, rt);
    this.formatBaselineAudit(report, rt);
    this.formatToolAvailability(report, rt);
  }

  /**
   * 渲染基线豁免区：豁免项已从 issues 中移除，若不在此显式列出，报告读者无法区分
   * "工具没报出来" 与 "报出来了但被豁免"，也无法复核豁免理由是否仍然成立。
   */
  private formatSuppressedIssues(report: InspectionReport, rt: RenderTarget): void {
    const suppressed = report.suppressedIssues ?? [];
    if (suppressed.length === 0) return;

    rt.lines.push('');
    rt.lines.push(
      `${rt.indent}${this.fmt.yellow('基线豁免')}: ${this.fmt.bold(String(suppressed.length))} ${this.fmt.dim('项（不计入评分）')}`,
    );
    for (const { issue, entry } of suppressed) {
      const location = `${issue.file}:${issue.line ?? 0}`;
      rt.lines.push(
        `${rt.indent}  ${this.fmt.dim('○')} ${entry.ruleId}  ${this.fmt.dim(location)}`,
      );
      rt.lines.push(
        `${rt.indent}    ${this.fmt.dim('理由')}: ${entry.reason ?? this.fmt.dim('[未记录，需补齐]')}`,
      );
      if (entry.owner) {
        rt.lines.push(`${rt.indent}    ${this.fmt.dim('责任人')}: ${entry.owner}`);
      }
      rt.lines.push(
        `${rt.indent}    ${this.fmt.dim('到期')}: ${entry.expiresAt ?? this.fmt.dim('永久（建议设置到期时间）')}`,
      );
    }
  }

  /**
   * 渲染豁免清单审计区：列出"活跃但本轮未命中"的休眠条目与"已过期"条目。
   * 豁免清单本身不自证——10 条看着像在防护的条目可能一条都没生效；不显式暴露，
   * 清单就会随时间虚增成无人能复核的仪式，满分也随之失去可信度。
   */
  private formatBaselineAudit(report: InspectionReport, rt: RenderTarget): void {
    const dormant = report.dormantEntries ?? [];
    const expired = report.expiredEntries ?? [];
    if (dormant.length === 0 && expired.length === 0) return;

    rt.lines.push('');
    rt.lines.push(
      `${rt.indent}${this.fmt.yellow('豁免清单待复核')}: ${this.fmt.bold(String(dormant.length))} ${this.fmt.dim('休眠')} / ${this.fmt.bold(String(expired.length))} ${this.fmt.dim('过期')}`,
    );
    for (const entry of dormant) {
      const location = `${entry.file}:${entry.line}`;
      rt.lines.push(
        `${rt.indent}  ${this.fmt.dim('○')} ${entry.ruleId}  ${this.fmt.dim(location)}`,
      );
      rt.lines.push(
        `${rt.indent}    ${this.fmt.dim('本轮未命中。若对应问题已修复请删除该条目；若属防护尚未触发的回归防线，请确认仍需保留。')}`,
      );
      if (entry.owner) {
        rt.lines.push(`${rt.indent}    ${this.fmt.dim('责任人')}: ${entry.owner}`);
      }
      rt.lines.push(
        `${rt.indent}    ${this.fmt.dim('到期')}: ${entry.expiresAt ?? this.fmt.dim('永久（建议设置到期时间）')}`,
      );
    }
    for (const entry of expired) {
      const location = `${entry.file}:${entry.line}`;
      rt.lines.push(
        `${rt.indent}  ${this.fmt.dim('✗')} ${entry.ruleId}  ${this.fmt.dim(location)} ${this.fmt.dim('已过期，已不再豁免，请清理')}`,
      );
    }
  }

  /** 渲染工具可用性矩阵：显式上报每个外部扫描工具的可用状态，消除"工具缺失静默跳过"盲区 */
  private formatToolAvailability(report: InspectionReport, rt: RenderTarget): void {
    const results = report.adapterResults;
    if (!results || results.length === 0) return;

    const unavailable = results.filter((r) => r.status === 'unavailable');
    const errors = results.filter((r) => r.status === 'error' || r.status === 'failed');
    const skipped = results.filter((r) => r.status === 'skipped');
    const normal = results.filter((r) => r.status === 'passed' || r.status === undefined);

    if (unavailable.length === 0 && errors.length === 0 && skipped.length === 0) {
      this.formatNormalTools(normal, rt);
      return;
    }

    this.formatUnavailableTools(unavailable, rt);
    this.formatErrorTools(errors, rt);
    this.formatSkippedTools(skipped, rt);
    this.formatNormalTools(normal, rt);
  }

  private formatUnavailableTools(unavailable: AdapterResult[], rt: RenderTarget): void {
    if (unavailable.length === 0) return;
    const names = unavailable.map((r) => this.fmt.yellow(r.adapterName)).join('、');
    rt.lines.push(
      `${rt.indent}${this.fmt.yellow('⚠ 工具不可用')}: ${names}（未安装，可用 zhshield tools install 安装）`,
    );
  }

  private formatErrorTools(errors: AdapterResult[], rt: RenderTarget): void {
    if (errors.length === 0) return;
    const withFindings = errors.filter((r) => r.issueCount > 0 || r.issues.length > 0);
    const trulyFailed = errors.filter((r) => r.issueCount === 0 && r.issues.length === 0);
    this.formatWithFindings(withFindings, rt);
    this.formatTrulyFailed(trulyFailed, rt);
  }

  private formatWithFindings(withFindings: AdapterResult[], rt: RenderTarget): void {
    if (withFindings.length === 0) return;
    // 非零退出码 ≠ 失败：有产出（issueCount>0）→ 检出问题；无产出（issueCount===0）→ 真失败
    const total = withFindings.reduce((sum, r) => sum + r.issueCount, 0);
    const names = withFindings
      .map((r) => `${this.fmt.yellow(r.adapterName)}${this.fmt.dim(`(${r.issueCount})`)}`)
      .join('、');
    rt.lines.push(`${rt.indent}${this.fmt.yellow(`⚠ 检出 ${total} 个问题`)}: ${names}`);
  }

  private formatTrulyFailed(trulyFailed: AdapterResult[], rt: RenderTarget): void {
    if (trulyFailed.length === 0) return;
    // P1（复查5）：此前无条件写"(错误详情已在 issues 中)"，但 status==='error' 且
    // issues 为空的适配器（ESLint 缺配置 / dep-cruiser 解析失败）根本没有 issue，
    // 这句是假承诺 → 改为优先展示 errorDetail 真实原因。
    const parts = trulyFailed.map((r) => {
      const reason = r.errorDetail ?? '未提供失败原因';
      return `${this.fmt.red(r.adapterName)}${this.fmt.dim(`(${reason})`)}`;
    });
    rt.lines.push(`${rt.indent}${this.fmt.red('✗ 工具执行失败')}: ${parts.join('  ')}`);
  }

  private formatSkippedTools(skipped: AdapterResult[], rt: RenderTarget): void {
    if (skipped.length === 0) return;
    const parts = skipped.map((r) => {
      const reason =
        r.skipDetail ??
        (r.skipReason === 'out-of-scope'
          ? '画像裁剪，已跳过'
          : r.skipReason === 'degraded'
            ? '降级运行'
            : '已跳过');
      return `${this.fmt.gray(r.adapterName)}${this.fmt.dim(`(${reason})`)}`;
    });
    rt.lines.push(`${rt.indent}${this.fmt.gray('- 已跳过')}: ${parts.join('  ')}`);
  }

  private formatNormalTools(normal: AdapterResult[], rt: RenderTarget): void {
    if (normal.length === 0) return;
    const parts = normal.map(
      (r) =>
        `${this.fmt.dim(r.adapterName)}${r.duration > 0 ? this.fmt.dim(`(${(r.duration / 1000).toFixed(1)}s)`) : ''}`,
    );
    rt.lines.push(`${rt.indent}${this.fmt.dim('工具')}: ${parts.join('  ')}`);
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

function formatRefactorReportBody(
  report: RefactorReport,
  lines: string[],
  indent: string,
  c: ColorTools,
): void {
  formatRefactorSummary(report, lines, indent, c);

  if (report.totalSmells === 0) return;

  formatSeverityBreakdown(report, lines, indent, c);
  formatCategoryBreakdown(report, lines, indent, c);
  formatCriticalFlags(report, lines, indent, c);
  formatCriticalFiles(report, lines, indent, c);
}

function formatRefactorSummary(
  report: RefactorReport,
  lines: string[],
  indent: string,
  c: ColorTools,
): void {
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

function formatSeverityBreakdown(
  report: RefactorReport,
  lines: string[],
  indent: string,
  c: ColorTools,
): void {
  const sevParts: string[] = [];
  for (const [sev, count] of Object.entries(report.bySeverity)) {
    if (count === 0) continue;
    const colorFn =
      sev === 'error' || sev === 'critical'
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

function formatCategoryBreakdown(
  report: RefactorReport,
  lines: string[],
  indent: string,
  c: ColorTools,
): void {
  if (Object.keys(report.byCategory).length === 0) return;

  const catParts = Object.entries(report.byCategory)
    .filter(([, c2]) => c2 > 0)
    .map(([cat, count]) => `${c.dim(cat)} ${c.bold(String(count))}`);
  if (catParts.length > 0) {
    lines.push(`${indent}  分类: ${catParts.join(', ')}`);
  }
}

function formatCriticalFlags(
  report: RefactorReport,
  lines: string[],
  indent: string,
  c: ColorTools,
): void {
  if (report.summary.criticalFiles > 0) {
    lines.push(`${indent}${c.red(`高危文件: ${report.summary.criticalFiles}`)}`);
  }
  if (report.summary.needsImmediateAction > 0) {
    lines.push(`${indent}${c.yellow(`需立即处理: ${report.summary.needsImmediateAction}`)}`);
  }
}

function formatCriticalFiles(
  report: RefactorReport,
  lines: string[],
  indent: string,
  c: ColorTools,
): void {
  const criticalFiles = report.files.filter(
    (f) => f.refactorPriority === 'critical' || f.refactorPriority === 'high',
  );
  if (criticalFiles.length === 0) return;

  lines.push('');
  lines.push(`${indent}${c.bold(c.red('需关注的文件:'))}`);
  for (const file of criticalFiles.slice(0, 10)) {
    const priorityColor =
      file.refactorPriority === 'critical' ? (s: string) => c.red(s) : (s: string) => c.yellow(s);
    lines.push(`${indent}  ${priorityColor('•')} ${c.dim(file.filePath)}`);
    lines.push(
      `${indent}    ${c.dim(`${file.totalSmells} 个异味, 可维护性评分: ${file.maintainabilityScore}`)}`,
    );
    for (const smell of file.smells.slice(0, 3)) {
      const sColor =
        smell.severity === 'error' ? (s: string) => c.red(s) : (s: string) => c.yellow(s);
      lines.push(
        `${indent}    ${sColor('·')} [${smell.ruleId}] ${smell.message}${smell.location.line ? ` (行 ${smell.location.line})` : ''}`,
      );
    }
    if (file.smells.length > 3) {
      lines.push(`${indent}      ${c.dim(`... 及另外 ${file.smells.length - 3} 项`)}`);
    }
  }
}

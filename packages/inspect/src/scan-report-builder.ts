import type { BaselineEntry, SuppressedIssue } from '@zh/shared';
import type { AdapterResult, InspectionReport, Issue, ScoreGrade, ScoreGradeLabel } from './types';
import type { EventEmitter } from '@zh/shared';
import { DegradationManager } from '@zh/shared';

const SCAN_CATEGORIES = [
  'architecture',
  'security',
  'quality',
  'performance',
  'documentation',
  'test',
  'dependency',
] as const;

/**
 * 判定某适配器是否"未实际执行"。
 *
 * 三种形态都没产出任何检查结论，一律计入未执行：
 * - degraded：降级跳过（根本没跑）
 * - unavailable：工具不可用
 * - error：跑了但失败（超时 / 非零退出），issues 恒为空
 *
 * error 曾被漏计：门禁只认 degraded，于是"跑挂"被当成"零问题 = 通过"，
 * 与 zhcheck 护栏"未检测不计为通过"的原则相悖。
 */
function isNotExecuted(result: AdapterResult): boolean {
  return result.degraded === true || result.status === 'error' || result.status === 'unavailable';
}

/** 等级阈值的唯一来源：scoreOf 与封顶后的等级重算共用，避免两处阈值各自漂移 */
function gradeOf(overall: number): ScoreGrade {
  return overall >= 90 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : 'D';
}

/**
 * out-of-scope 跳过：工具本就不在项目画像 scope 内（契约见 AdapterResult.skipReason），
 * 是既定裁剪而非"没查成"，故不构成覆盖率缺口。
 */
function isOutOfScope(result: AdapterResult): boolean {
  return result.status === 'skipped' && result.skipReason === 'out-of-scope';
}

/**
 * 覆盖率 = 真正执行的检查数 / 应执行检查数（out-of-scope 不计入分母）。
 * 无任何应执行检查时返回 0：什么都没查，不能算覆盖充分。
 */
function coverageOf(results: AdapterResult[]): number {
  const denominator = results.length - results.filter(isOutOfScope).length;
  if (denominator <= 0) return 0;
  return (denominator - results.filter(isNotExecuted).length) / denominator;
}

/** 覆盖率封顶：查得越少越不能给高分，断点对齐 A/B/C/D 分档（80% 不限，50% 至多 C，低于 50% 至多 D） */
function coverageCap(coverage: number): number {
  if (coverage >= 0.8) return 100;
  if (coverage >= 0.5) return 74;
  return 59;
}

/** 巡检报告构建入参：项目、扫描方式、耗时、问题列表与各适配器结果 */
export interface ScanReportInput {
  projectId: string;
  scanType: InspectionReport['scanType'];
  duration: number;
  issues: Issue[];
  adapterResults: AdapterResult[];
  /** SOP 分支不惩罚 info 级问题（保持原有计分行为） */
  penalizeInfo?: boolean;
  /** 基线豁免命中数（透传至报告供消费方观测） */
  suppressedCount?: number;
  /** 被基线豁免的问题明细（含命中条目的豁免理由/责任人/到期），透传至报告供输出层显式呈现 */
  suppressedIssues?: SuppressedIssue<Issue>[];
  /** 休眠豁免条目（活跃但本轮未命中）：透传供输出层提示清单复核 */
  dormantEntries?: BaselineEntry[];
  /** 已过期豁免条目：透传供输出层提示清理 */
  expiredEntries?: BaselineEntry[];
}

/**
 * ScanReportBuilder — 巡检报告构建
 *
 * 负责从 Issue 列表计算汇总 / 评分 / 等级 / 建议，
 * 并发出 scan:completed 事件，供 InspectEngine 复用。
 */
export class ScanReportBuilder {
  private emitter: EventEmitter;
  private degradationManager: DegradationManager;

  constructor(emitter: EventEmitter, degradationManager: DegradationManager) {
    this.emitter = emitter;
    this.degradationManager = degradationManager;
  }

  summarize(issues: Issue[]): InspectionReport['summary'] {
    return {
      total: issues.length,
      error: issues.filter((i) => i.severity === 'error').length,
      warning: issues.filter((i) => i.severity === 'warning').length,
      info: issues.filter((i) => i.severity === 'info').length,
    };
  }

  scoreOf(summary: InspectionReport['summary'], penalizeInfo = true): { overall: number; grade: ScoreGrade } {
    const overall =
      summary.total === 0
        ? 100
        : Math.max(
            0,
            100 - summary.error * 10 - summary.warning * 3 - (penalizeInfo ? summary.info : 0),
          );
    const grade = gradeOf(overall);
    return { overall, grade };
  }

  categoryCounts(issues: Issue[]): Record<string, number> {
    return Object.fromEntries(
      SCAN_CATEGORIES.map((c) => [c, issues.filter((i) => i.category === c).length]),
    );
  }

  recommendations(issues: Issue[]): string[] {
    const recs: string[] = [];
    const byCategory = new Map<string, number>();
    for (const issue of issues) {
      byCategory.set(issue.category, (byCategory.get(issue.category) || 0) + 1);
    }
    for (const [cat, count] of byCategory) {
      if (count > 5) recs.push(`发现 ${count} 个 ${cat} 类问题，建议优先处理`);
    }
    const degradedLevel = this.degradationManager.getLevel();
    if (degradedLevel > 0) {
      recs.push(`当前降级等级: Level ${degradedLevel}，部分工具已跳过`);
      const errors = this.degradationManager.getToolErrors();
      for (const [tool, err] of errors) {
        recs.push(`工具 ${tool} 出错: ${err}`);
      }
    }
    return recs;
  }

  async emitScanCompleted(projectId: string, duration: number, issues: Issue[]): Promise<void> {
    await this.emitter.emit({
      type: 'scan:completed',
      payload: {
        module: 'inspect',
        projectId,
        duration,
        totalIssues: issues.length,
        issueCategories: this.categoryCounts(issues),
        timestamp: new Date(),
      },
    });
  }

  buildReport(input: ScanReportInput): InspectionReport {
    const summary = this.summarize(input.issues);
    const baseScore = this.scoreOf(summary, input.penalizeInfo);
    const degraded = input.adapterResults.filter(isNotExecuted).length;
    const coverage = coverageOf(input.adapterResults);
    const overall = Math.min(baseScore.overall, coverageCap(coverage));
    const cappedGrade = gradeOf(overall);
    const grade: ScoreGradeLabel =
      degraded > 0 ? `${cappedGrade} [${degraded}工具降级]` : cappedGrade;
    const score = { overall, grade };
    return {
      projectId: input.projectId,
      timestamp: new Date(),
      scanType: input.scanType,
      duration: input.duration,
      score,
      issues: input.issues,
      summary,
      adapterResults: input.adapterResults,
      // P0（复查4）：顶层降级计数，供 CLI 护栏与机器可读报告直接消费
      degraded,
      // P0（2026-10-04）：未执行的检查恒产出零 issues，若不封顶则"覆盖率越低分数越高"
      coverage,
      recommendations: this.recommendations(input.issues),
      suppressedCount: input.suppressedCount ?? 0,
      suppressedIssues: input.suppressedIssues ?? [],
      dormantEntries: input.dormantEntries ?? [],
      expiredEntries: input.expiredEntries ?? [],
    };
  }
}

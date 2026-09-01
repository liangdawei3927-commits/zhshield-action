import type { AdapterResult, InspectionReport, Issue } from './types';
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

export interface ScanReportInput {
  projectId: string;
  scanType: InspectionReport['scanType'];
  duration: number;
  issues: Issue[];
  adapterResults: AdapterResult[];
  /** SOP 分支不惩罚 info 级问题（保持原有计分行为） */
  penalizeInfo?: boolean;
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

  scoreOf(summary: InspectionReport['summary'], penalizeInfo = true): InspectionReport['score'] {
    const overall =
      summary.total === 0
        ? 100
        : Math.max(
            0,
            100 - summary.error * 10 - summary.warning * 3 - (penalizeInfo ? summary.info : 0),
          );
    const grade = overall >= 90 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : 'D';
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
    return {
      projectId: input.projectId,
      timestamp: new Date(),
      scanType: input.scanType,
      duration: input.duration,
      score: this.scoreOf(summary, input.penalizeInfo),
      issues: input.issues,
      summary,
      adapterResults: input.adapterResults,
      recommendations: this.recommendations(input.issues),
    };
  }
}

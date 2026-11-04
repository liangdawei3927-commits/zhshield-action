/**
 * 流水线报告里的 refactor 域出分输入（从 engines.ts 拆出）。
 *
 * 口径：`refactorSnapshotPatch` 与 dashboard-state 同源同形，与分类页单独跑重构扫描
 * 走的是同一组数 —— 两条路径不可能漂移（历史上出过"卡片与分类页对不上"）。
 *
 * 单独成文件的原因：engines.ts 已在 400 行体积阈值边缘（oversized-file 是门禁项），
 * 与其把它挤过线，不如让「出分口径」有独立的名字和位置。
 */
import type { PipelineReport } from '@zh/pipeline';
import { refactorSnapshotScore } from './engines-scanners';
import type { DiagnosticSource, DomainDimensionScore } from '../zh-diagnostics-types';

/** 从流水线报告取 refactor 域的维度分（无重构结果则 undefined） */
export function pipelineRefactorDomainScores(
  report: PipelineReport,
): Partial<Record<DiagnosticSource, DomainDimensionScore>> | undefined {
  if (!report.refactor) return undefined;
  const dimensionScore = refactorSnapshotScore(report.refactor);
  return dimensionScore ? { refactor: dimensionScore } : undefined;
}

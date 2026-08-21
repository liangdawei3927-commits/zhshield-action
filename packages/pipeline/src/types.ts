import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport } from '@zh/kernel';

export interface PipelineReport {
  timestamp: Date;

  guard: GuardReport | RuleEngineReport | null;

  inspect: InspectionReport | RuleEngineReport | null;

  refactor: RefactorReport | null;

  passed: boolean;

  stage: 'guard' | 'inspect' | 'refactor' | 'complete' | 'failed';

  error?: string;
}

/**
 * 流水线报告工厂：统一补齐 timestamp 与空阶段字段，
 * 避免各 stage 分支手写完整对象。
 */
export function createReport(
  input: Partial<Omit<PipelineReport, 'timestamp' | 'passed' | 'stage'>> &
    Pick<PipelineReport, 'passed' | 'stage'>,
): PipelineReport {
  return {
    timestamp: new Date(),
    guard: input.guard ?? null,
    inspect: input.inspect ?? null,
    refactor: input.refactor ?? null,
    passed: input.passed,
    stage: input.stage,
    error: input.error,
  };
}

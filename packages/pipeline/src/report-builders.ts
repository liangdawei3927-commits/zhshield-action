import type { PipelineReport } from './types';

/** 构造阶段失败/阻断的流水线报告 */
export function buildFailureReport(
  stage: PipelineReport['stage'],
  guard: PipelineReport['guard'],
  inspect: PipelineReport['inspect'],
  error?: string,
): PipelineReport {
  return {
    timestamp: new Date(),
    guard,
    inspect,
    refactor: null,
    passed: false,
    stage,
    ...(error !== undefined ? { error } : {}),
  };
}

/** 构造流水线成功报告（重构由独立入口 runRefactor() / 桌面重构页负责，全流水线不串行跑重构） */
export function buildSuccessReport<
  G extends PipelineReport['guard'],
  I extends PipelineReport['inspect'],
>(guard: G, inspect: I): PipelineReport {
  return {
    timestamp: new Date(),
    guard,
    inspect,
    refactor: null,
    passed: true,
    stage: 'complete',
  };
}

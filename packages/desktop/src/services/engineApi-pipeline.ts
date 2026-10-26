/**
 * 引擎 API 分片 — Pipeline 流水线引擎：按预设执行流水线扫描
 *
 * HTTP 模式直连服务端接口；IPC 无引擎时返回失败报告兜底。
 */
import type { PipelineReportData } from '../types/electron';
import { runPipelineViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── Pipeline 流水线引擎 ──────────────────────────────────

export async function runPipeline(
  projectPath: string,
  options?: { dryRun?: boolean; sop?: boolean; presetName?: string; origin?: 'auto' },
): Promise<PipelineReportData> {
  if (isHttpMode()) return runPipelineViaHttp(projectPath, options);
  const api = getAPI();
  if (!api?.engine) {
    return {
      passed: false,
      stage: 'idle',
      timestamp: new Date().toISOString(),
      error: 'IPC not available',
    };
  }
  return api.engine.runPipeline(projectPath, options);
}

/**
 * 引擎 API 分片 — Dependency 依赖管家引擎：依赖扫描与基线重锁
 *
 * 走 Electron IPC，引擎不可用时返回空报告 / 错误结果兜底（不 throw）。
 */
import { t } from '@zh/i18n';
import type { DependencyReportData, DepsRelockResult } from '../types/electron';
import { emptyDependencyReportData } from './empty-engine-reports';
import { getAPI } from './engineApi-transport';

// ─── Dependency 依赖管家引擎 ─────────────────────────────

export async function runDeps(projectPath: string): Promise<DependencyReportData> {
  const api = getAPI();
  if (!api?.engine) {
    return emptyDependencyReportData(t('engine.engineUnavailable'));
  }
  return api.engine.runDeps(projectPath);
}

/** 显式重锁依赖哈希基线（引擎无可用时返回错误，不 throw） */
export async function depsRelockBaseline(projectPath: string): Promise<DepsRelockResult> {
  const api = getAPI();
  if (!api?.engine) {
    return { ok: false, error: t('engine.engineUnavailable') };
  }
  return api.engine.depsRelockBaseline(projectPath);
}

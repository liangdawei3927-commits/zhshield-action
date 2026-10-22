/**
 * 引擎 API 分片 — Scoring 评分引擎与结果汇总
 *
 * HTTP 模式直连服务端接口；IPC 不可用或读取失败时返回 null / 空数组兜底。
 * 汇总生成报告为只读路径：不触发任何扫描。
 */
import type {
  HealthScoreData,
  ProjectProfileData,
  DomainScoreData,
  ScoreDimension,
} from '../types/electron';
import { getScoreViaHttp, getScoreHistoryViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── Scoring 评分引擎 ──────────────────────────────────────

export async function getScore(projectId: string): Promise<HealthScoreData | null> {
  if (isHttpMode()) return getScoreViaHttp(projectId);
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getScore(projectId);
  } catch {
    return null;
  }
}

/**
 * 分类页实时评分：读该域最近一次检查落盘的按域快照自带评分（跑完即有）。
 * 快照缺失 / 旧格式（无评分）时返回 null，由调用方回退到 getScore 汇总数据。
 */
export async function getDomainScore(
  projectPath: string,
  dimension: ScoreDimension,
): Promise<DomainScoreData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getDomainScore(projectPath, dimension);
  } catch {
    return null;
  }
}

export async function getScoreHistory(projectId: string): Promise<HealthScoreData[]> {
  if (isHttpMode()) return getScoreHistoryViaHttp(projectId);
  const api = getAPI();
  if (!api?.engine) return [];
  try {
    return await api.engine.getScoreHistory(projectId);
  } catch {
    return [];
  }
}

/** 项目画像（含子模块列表），供报告页展示模块级评分卡；HTTP 模式服务端未暴露画像接口时返回 null */
export async function getProfile(projectPath: string): Promise<ProjectProfileData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getProfile(projectPath);
  } catch {
    return null;
  }
}

// ─── 结果汇总（只读，不发起检查）──────────────────────────

/**
 * 汇总生成报告：只读各域最新落盘结果 → 统一维度加权 → 落库。
 * 不触发任何扫描；各域都没有可用结果时返回 null（由 UI 提示先运行检查）。
 */
export async function generateReportSummary(projectPath: string): Promise<HealthScoreData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.generateReportSummary(projectPath);
  } catch {
    return null;
  }
}

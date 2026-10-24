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
  DomainReportSnapshot,
  DomainReportSource,
  DomainScanBlobData,
  DomainScanRecordData,
  HealthOverviewData,
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

/**
 * 报告中心总览的实时视图：十维一次取齐 + 实时总评，**只读不落库**。
 *
 * 与 `getScore`（scores 表最近一条历史汇总记录）的区别：那是「上次汇总那一刻」的快照，
 * 这是「当下」的值。总览卡片必须用它，否则卡片与分类页必然对不上。
 * IPC 不可用 / 各域都没跑过 → null，调用方回退到汇总记录（并标注数据时间）。
 */
export async function getHealthOverview(projectPath: string): Promise<HealthOverviewData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getHealthOverview(projectPath);
  } catch {
    return null;
  }
}

/**
 * 读该域最近一次落盘快照（仅问题项）。用于「有历史评分即可查看详情」——
 * 评分来自持久化汇总/按域快照，而页面内存 report 只在本次会话扫描后才有，
 * 二者不同源会导致「有分无详情」。无快照 / IPC 不可用返回 null。
 */
export async function getDomainReport(
  projectPath: string,
  source: DomainReportSource,
): Promise<DomainReportSnapshot | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getDomainReport(projectPath, source);
  } catch {
    return null;
  }
}

/**
 * 该域是否已有落盘结果（完整报告 or 归一化快照）。
 *
 * 「有评分 ⇔ 有按钮」的判据就落在这里：评分本来就算自磁盘，因此只要该域跑过，
 * 这里必然为 true，右上角详情入口才会出现；没跑过的域一律 false（不显示按钮）。
 * IPC 不可用 / 出错按 false 处理（宁可少给一个入口，也不给一个点进去是空态的入口）。
 */
export async function hasDomainResult(projectPath: string, domain: string): Promise<boolean> {
  if (isHttpMode()) return false;
  const api = getAPI();
  if (!api?.engine) return false;
  try {
    return await api.engine.hasDomainResult(projectPath, domain);
  } catch {
    return false;
  }
}

/**
 * 原样读回某域的归一化快照（`diagnostics/domains/<domain>.json`）。
 *
 * 用途：该域**没有**完整报告（本次升级前扫的）时，「点详情」要能立刻看到
 * 上次结果与扣分依据，而不是被迫重扫一遍。快照里就是评分计算的那批问题条目，
 * 与页面上的分数同源，因此展示它不算「拼假数据」——它是真实执行过的那次结果。
 * 返回原样 JSON（不做结构校验：垃圾域是 `items/checks` 结构，与诊断报告不同）。
 */
export async function getDomainSnapshotRaw(
  projectPath: string,
  domain: string,
): Promise<unknown | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getDomainSnapshotRaw(projectPath, domain);
  } catch {
    return null;
  }
}

/**
 * 读回某域最近一次**完整报告**（扫描成功时落盘的那份）。
 *
 * 与 `getDomainReport` 的区别：后者是归一化问题条目快照（只够回答「有哪些问题」），
 * 本函数返回的是页面报告对象原样 —— 依赖的 outdated/lockfile、重构的 smells、
 * 技术债的 debtIndex 等域特有结构都在，详情页可原样渲染、口径不变。
 * 不存在 / 损坏 / IPC 不可用 → null（不猜不造）。
 */
export async function getSavedDomainReport<T>(
  projectPath: string,
  domain: string,
): Promise<T | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    const raw = await api.engine.getSavedDomainReport(projectPath, domain);
    return raw === null ? null : (raw as T);
  } catch {
    return null;
  }
}

/**
 * 某域扫描历史（新 → 旧）。
 *
 * 每次扫描一条，含该次的分数 / 问题数 / severity 分布 / 指纹集 ——
 * 这是「这次比上次涨了还是跌了」唯一的可回溯依据（快照只保留最近一次）。
 * IPC 不可用 / 失败 → 空数组（页面按「无历史」渲染，不编造）。
 */
export async function listDomainHistory(
  projectPath: string,
  domain: string,
  limit?: number,
): Promise<DomainScanRecordData[]> {
  if (isHttpMode()) return [];
  const api = getAPI();
  if (!api?.engine) return [];
  try {
    return await api.engine.listDomainHistory(projectPath, domain, limit);
  } catch {
    return [];
  }
}

/** 某次扫描的明细（未保存 / 损坏 → null） */
export async function getDomainScanBlob(
  projectPath: string,
  blob: string,
): Promise<DomainScanBlobData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getDomainScanBlob(projectPath, blob);
  } catch {
    return null;
  }
}

/** 某域最近一次扫描记录；无历史 → null */
export async function getLatestDomainScan(
  projectPath: string,
  domain: string,
): Promise<DomainScanRecordData | null> {
  if (isHttpMode()) return null;
  const api = getAPI();
  if (!api?.engine) return null;
  try {
    return await api.engine.getLatestDomainScan(projectPath, domain);
  } catch {
    return null;
  }
}

/**
 * 某域完整报告落盘（扫描成功后调用）。
 * 失败静默 —— 回看是增强能力，不能影响扫描主链路。
 */
export async function saveDomainReport(
  projectPath: string,
  domain: string,
  report: unknown,
): Promise<void> {
  if (isHttpMode()) return;
  const api = getAPI();
  if (!api?.engine) return;
  try {
    await api.engine.saveDomainReport(projectPath, domain, report);
  } catch {
    // 落盘失败不阻断 UI
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

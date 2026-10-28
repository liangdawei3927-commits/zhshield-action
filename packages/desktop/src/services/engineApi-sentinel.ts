/**
 * 引擎 API 分片 — Sentinel 哨兵监控：事件查询、启停与开关状态
 *
 * HTTP 模式直连服务端接口；IPC 桥接缺失时返回空列表 / 默认状态兜底。
 */
import type { SentinelEvent } from '@zh/sentinel';
import type { SentinelEventQuery } from '../types/electron';
import { getSentinelEventsViaHttp, startSentinelViaHttp } from './serverApi';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── Sentinel 哨兵监控 ────────────────────────────────────

export async function getSentinelEvents(
  options?: SentinelEventQuery,
): Promise<SentinelEvent[]> {
  if (isHttpMode()) return getSentinelEventsViaHttp(options);
  const api = getAPI();
  if (!api?.sentinel) return [];
  return api.sentinel.getEvents(options);
}

/**
 * 启动监控。
 *
 * `started` / `skipped` 是主进程三个监视器（文件 / 日志 / 进程）的实际启停结果，
 * 例：`['file-monitor']` / `['log-collector: no log files found']`。
 * **这两个字段此前在返回类型里被漏掉**（只声明了 started，skipped 直接丢），
 * 于是「到底监控了什么」在界面上永远看不到 —— 只有 0 覆盖也照样显示 100 分。
 * 渲染层据此展示监控范围，见 `sentinel-logic.describeMonitorScope`。
 */
export async function startSentinelMonitoring(
  projectPath: string,
): Promise<{ ok: boolean; started: string[]; skipped: string[]; disabled?: boolean }> {
  if (isHttpMode()) return startSentinelViaHttp(projectPath);
  const api = getAPI();
  if (!api?.sentinel) return { ok: false, started: [], skipped: [] };
  return api.sentinel.startMonitoring(projectPath, projectPath);
}

/**
 * 停止该项目的哨兵监控。
 *
 * 与 start 一样用 projectPath 兼作 projectId（主进程幂等键），调用方不必再知道
 * "主进程内部还另有一套 id" 这个细节 —— 那是此前取消链路两套序号对不上的根因。
 * `stopped=false` = 该项目本就不在监控中（如实返回，不粉饰成"已停止"）。
 */
export async function stopSentinelMonitoring(
  projectPath: string,
): Promise<{ ok: boolean; stopped: boolean }> {
  const api = getAPI();
  if (!api?.sentinel) return { ok: false, stopped: false };
  try {
    const result = await api.sentinel.stopMonitoring(projectPath);
    return { ok: result.ok, stopped: result.stopped };
  } catch {
    return { ok: false, stopped: false };
  }
}

export async function getSentinelState(): Promise<{ enabled: boolean }> {
  const api = getAPI();
  if (!api?.sentinel) return { enabled: true };
  try {
    return await api.sentinel.getState();
  } catch {
    return { enabled: true };
  }
}

export async function setSentinelEnabled(enabled: boolean): Promise<{ ok: boolean }> {
  const api = getAPI();
  if (!api?.sentinel) return { ok: false };
  return api.sentinel.setEnabled(enabled);
}

/**
 * 引擎 API 分片 — 垃圾清理：清理执行与批次恢复
 *
 * HTTP 模式不支持远端清理/恢复，直接返回不支持提示；IPC 无引擎时返回空结果。
 */
import { t } from '@zh/i18n';
import type { GarbageCleanResultData, GarbageRestoreResultData } from '../types/electron';
import { isHttpMode, getAPI } from './engineApi-transport';

// ─── 垃圾清理 ───────────────────────────────────────────

export async function cleanGarbage(
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
): Promise<GarbageCleanResultData> {
  if (isHttpMode())
    return {
      batchId: '',
      cleaned: [],
      freedBytes: 0,
      failed: [t('engine.remoteCleanUnsupported')],
    };
  const api = getAPI();
  if (!api?.engine)
    return { batchId: '', cleaned: [], freedBytes: 0, failed: [t('engine.engineUnavailable')] };
  return api.engine.cleanGarbage(projectPath, items);
}

export async function restoreGarbage(
  projectPath: string,
  batchId: string,
): Promise<GarbageRestoreResultData> {
  if (isHttpMode())
    return { restored: 0, restoredBytes: 0, failed: [t('engine.remoteRestoreUnsupported')] };
  const api = getAPI();
  if (!api?.engine)
    return { restored: 0, restoredBytes: 0, failed: [t('engine.engineUnavailable')] };
  return api.engine.restoreGarbage(projectPath, batchId);
}

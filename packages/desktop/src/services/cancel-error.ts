/**
 * 取消错误的识别（渲染层）。
 *
 * 用户点「停止」后，主进程用 reject 把取消送回来 —— 走的和真实故障是同一条
 * IPC 通道。若不识别，页面会把它渲染成「体检失败 / 扫描失败」，把用户的主动
 * 操作报成系统故障。
 *
 * 判据不依赖本地化文案（文案会随语言与措辞变化，一改判据就失效），而是认主进程
 * 写入的固定 ASCII 标记 `[cancelled]`（见 electron/pipeline-protocol.ts 的
 * CANCELLED_ERR_TAG，两处必须一致，由测试锁住）。同时兼容裸文案，兜住
 * 无标记的旧路径。
 */
import { t } from '@zh/i18n';

/** 与 electron/pipeline-protocol.ts 的 CANCELLED_ERR_TAG 必须一致 */
export const CANCELLED_ERR_TAG = '[cancelled]';

export function isCancelledMessage(message: string): boolean {
  if (!message) return false;
  if (message.includes(CANCELLED_ERR_TAG)) return true;

  // i18n 未初始化时 t() 会回退成键名本身，拿键名去匹配会把任何含
  // "task.cancelled" 的调试串误判成取消，故跳过。
  const localized = t('task.cancelled');
  if (!localized || localized.startsWith('task.')) return false;
  return message.includes(localized);
}

export function isCancelledError(err: unknown): boolean {
  if (err instanceof Error) return isCancelledMessage(err.message);
  if (typeof err === 'string') return isCancelledMessage(err);
  return false;
}

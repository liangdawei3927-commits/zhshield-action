/**
 * 一键备份系统 — 事件定义
 *
 * 基于 kernel EventBus 的事件类型常量与 payload 类型重导出。
 *
 * 事件列表：
 *   backup:request        → 请求备份
 *   backup:started        → 备份开始
 *   backup:progress       → 备份进度
 *   backup:completed      → 备份完成
 *   backup:failed         → 备份失败
 *   backup:config-updated → 配置更新
 *   backup:list-records   → 查询备份记录（request-response）
 *   backup:get-detail     → 获取备份详情（request-response）
 *   backup:delete-record  → 删除备份记录（request-response）
 */

export { BACKUP_EVENTS } from './types';
export type {
  BackupRequestPayload,
  BackupStartedPayload,
  BackupProgressPayload,
  BackupCompletedPayload,
  BackupFailedPayload,
  BackupConfigUpdatedPayload,
} from './types';

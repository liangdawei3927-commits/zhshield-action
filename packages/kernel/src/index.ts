// @zh/kernel
export const VERSION = '0.1.0';
export { EventBus } from './bus';
export { ConfigManager } from './config';
export { Logger } from './log';
export type { LogLevel } from './log';
export { FileHelper } from './file';
export { PluginLoader } from './plugin';
export type { Plugin } from './plugin';

// ─── SOP (智汇云脑 — 规则系统) ──────────────────────────────
export * from './sop/index';

// ─── SOP 规则引擎 ──────────────────────────────────────────
export { SopRuleEngine, ContentInterpreter } from './runner';
export type { RuleContext } from './sop/_meta/rule-context';
export type {
  RuleEvaluation,
  RuleEngineReport,
  Violation,
  ContentInstruction,
  ToolDispatchInstruction,
} from './sop/_meta/rule-evaluation';

// ─── 增量备份（旧版，兼容） ──────────────────────────────────
export { BackupManager } from './backup/incremental-backup';
export type {
  BackupFileEntry,
  BackupManifest,
  BackupResult,
  BackupOptions,
} from './backup/incremental-backup';

// ─── 一键备份系统 ──────────────────────────────────────────
export * from './backup/index';

// ─── 通知服务 ──────────────────────────────────────────────
export { NotificationService, notificationService } from './notification';
export type { AppNotification, NotificationStore, NotificationListener } from './notification';

// ─── 审计日志（智汇大脑 — 链式哈希完整性） ──────────────────
export { AuditLogger } from './audit';
export type { AuditEntry, AuditQuery, AuditStats } from './audit';

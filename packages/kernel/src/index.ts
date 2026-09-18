// @zh/kernel
export const VERSION = '0.1.0';
export { EventBus } from './bus';
export { ConfigManager } from './config';
export { Logger } from './log';
export type { LogLevel } from './log';
export { FileHelper } from './file';
export { PluginLoader } from './plugin';
export type { Plugin } from './plugin';
export { parseYamlText, stringifyYaml } from './yaml';

// ─── SOP (智汇云脑 — 规则系统) ──────────────────────────────
export * from './sop/index';

// ─── SOP 规则引擎 ──────────────────────────────────────────
export { SopRuleEngine, ContentInterpreter } from './runner';
// 层判定语义的唯一实现：门禁适配器与内核 layer-boundary 内联评估器共用，
// 保证同一处违规在门禁与体检得到一致结论（T8 口径统一）。
export { detectLayer, detectLayerByName } from './runner/scan-utils';
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

// ─── 指标收集（智汇大脑 — Counter/Gauge/Histogram） ─────────
export { MetricsCollector } from './metrics/metrics-collector';
export type { CounterMetric, GaugeMetric, HistogramMetric } from './metrics/metrics-collector';

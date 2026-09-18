/**
 * @zh/garbage — 垃圾清理域
 *
 * 职责（《导航各司其职》方案 T5）：
 *   · 自有检测器：构建产物 / 垃圾文件 / 空文件（文件系统级）
 *   · 自有判定：garbage 域 SOP 规则（死代码 / 重复代码 / 未使用依赖）
 *   · 自有动作：移入项目内回收站 / 恢复
 *
 * 明确不做：不调用安全引擎取垃圾字段（安全中心只做漏洞 / 恶意代码 / 密钥），
 * 不复用 SecurityScanReport 作为报告载体。
 */
export const VERSION = '0.1.0';

export { detectFsGarbage } from './fs-detector';
export { cleanGarbage, restoreGarbage } from './cleaner';
export {
  GARBAGE_RULE_TYPE_MAP,
  isGarbageRuleMapped,
  mapRuleIdToGarbageType,
  issuesToGarbageItems,
} from './item-mapper';
export type { GarbageViolationLike } from './item-mapper';
export { buildGarbageReport, FS_DETECTOR_ID } from './report';
export type { BuildGarbageReportInput, GarbageEvaluationLike } from './report';
export type {
  GarbageItem,
  GarbageType,
  GarbageCheckStatus,
  GarbageCleanInput,
  GarbageCleanResult,
  GarbageRestoreResult,
  GarbageScanReport,
} from './types';

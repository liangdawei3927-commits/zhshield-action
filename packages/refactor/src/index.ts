export const VERSION = '0.2.0';

export { RefactorEngine } from './engine';
export { DEFAULT_CONFIG } from './types';
export {
  parseFile,
  computeCyclomaticComplexity,
  computeNestingDepth,
  findDuplicateCodeBlocks,
  scanDuplicateCodeBlocks,
} from './ast-helper';
export { ALL_DETECTORS } from './adapters/index';
export { countSmellsByFileAndRule, diffBaseline, applyRefactorBaseline } from './baseline';
export type { RefactorBaseline, RefactorBaselineFilterResult } from './baseline';

// 自动修复的备份 / 恢复（§5.5「可回滚」不变量）：桌面端与 CLI 的事后撤销走这两个入口。
export {
  readBackupManifest,
  restoreFromBackup,
  atomicWriteFileSync,
  isWithinProject,
} from './auto-fix-apply';
export type { AutoFixBackupManifest, RestoreBackupResult } from './auto-fix-apply';

// 自动修复备份的枚举 / 撤销（备份目录约定的唯一真源 —— 写备份与读备份必须同源）
export { listAutoFixBackups, restoreAutoFixBackup } from './auto-fix-backup';
export type { AutoFixBackupEntry, RestoreAutoFixResult } from './auto-fix-backup';

export type {
  CodeSmell,
  FileSmellReport,
  RefactorReport,
  RefactorConfig,
  TextEdit,
  Fix,
  FixResult,
  RefactorAutoFixResult,
} from './types';

export type { ParsedFile, ParsedClass, ParsedFunction, DuplicateBlock } from './ast-helper';

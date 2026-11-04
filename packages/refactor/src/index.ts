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
export {
  countSmellsByFileAndRule,
  diffBaseline,
  applyRefactorBaseline,
} from './baseline';
export type { RefactorBaseline, RefactorBaselineFilterResult } from './baseline';

// 自动修复的备份 / 恢复（§5.5「可回滚」不变量）：桌面端与 CLI 的事后撤销走这两个入口。
export {
  readBackupManifest,
  restoreFromBackup,
  atomicWriteFileSync,
  isWithinProject,
} from './auto-fix-apply';
export type { AutoFixBackupManifest, RestoreBackupResult } from './auto-fix-apply';

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

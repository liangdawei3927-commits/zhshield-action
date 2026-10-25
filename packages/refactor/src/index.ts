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

export type {
  CodeSmell,
  FileSmellReport,
  RefactorReport,
  RefactorConfig,
  TextEdit,
  Fix,
  FixResult,
} from './types';

export type { ParsedFile, ParsedClass, ParsedFunction, DuplicateBlock } from './ast-helper';

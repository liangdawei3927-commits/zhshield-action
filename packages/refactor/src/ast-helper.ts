// ---------------------------------------------------------------------------
// AST 解析 / 复杂度度量 / 外部引用计数 / 跨文件重复检测 的汇总入口。
// 原先集中在本文件的实现已按功能域下沉到同目录的三个兄弟模块：
//   - ast-helper-parse.ts     源文件解析与圈复杂度/嵌套深度计算
//   - ast-helper-envy.ts      Feature Envy 外部引用计数
//   - ast-helper-duplicate.ts 跨文件重复代码块扫描与归一化
// 本文件仅做再导出，公开 API 与调用方 import 路径保持不变。
// 依赖方向单向：ast-helper → 兄弟模块，兄弟模块之间互不依赖（仅 parse 被
// duplicate 以 type-only 方式引用），不存在循环依赖。
// ---------------------------------------------------------------------------

export type {
  ParsedFile,
  ParsedClass,
  ParsedFunction,
  ImportInfo,
  ExportInfo,
} from './ast-helper-parse';

export { parseFile, computeCyclomaticComplexity, computeNestingDepth } from './ast-helper-parse';

export { collectExternalCalls } from './ast-helper-envy';

export type { DuplicateBlock } from './ast-helper-duplicate';

export { scanDuplicateCodeBlocks, findDuplicateCodeBlocks } from './ast-helper-duplicate';

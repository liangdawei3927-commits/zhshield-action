/**
 * SOP 评估 → 内部报告格式的纯转换函数（转发到 @zh/scoring）。
 *
 * 实现已迁至共享包 `@zh/scoring`（server/scoring 共用），此处保留为再导出兼容层，
 * 避免 engines.ts 与既有测试改动导入路径。保持文件原有注释语义。
 */
export {
  convertGuardEvaluations,
  convertInspectEvaluations,
  convertTraditionalGuardResults,
} from '@zh/scoring';
export type {
  ConvertedGuardResult,
  ConvertedInspectIssue,
  GuardCheckResultLike,
} from '@zh/scoring';

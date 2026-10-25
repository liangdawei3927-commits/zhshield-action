/**
 * sop-sync-compare.mjs 的类型声明。
 * 加了它，引用方的编辑器与（若将来把 __tests__ 纳入 typecheck 的）tsc 都能拿到类型，
 * 不必在每个 import 处写 @ts-ignore。
 */
export interface SopSyncResult {
  ok: boolean;
  checked: number;
  missing: string[];
  extra: string[];
  differing: string[];
  problems: string[];
}

export function compareSopTrees(srcDir: string, dstDir: string): SopSyncResult;
export function describeSopSyncProblems(result: SopSyncResult): string[];

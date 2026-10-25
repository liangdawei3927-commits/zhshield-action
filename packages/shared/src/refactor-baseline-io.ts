/**
 * 重构棘轮基线（refactor-baseline.json）读写口（随 @zh/shared 导出，与 baseline.ts 同约定）。
 *
 * 与误报豁免基线（baseline.json，按 ruleId:file:line:column 逐条豁免）不同：
 * 重构基线是**计数棘轮**——按 文件 → 规则 记录存量异味数，超出基线计数的部分才进报告。
 * 存量进基线后，报告从「全量刷屏」变成「只报增量」，计数级匹配对行号漂移免疫。
 *
 * 持久化到 <projectRoot>/.zhshield/refactor-baseline.json（与 baseline.json / deps-baseline.json 同目录约定）。
 * 路径约定留在 shared，不进具体引擎包（与 baseline.ts 的分层一致）。
 * 读取失败/损坏/版本不符降级为 null（无基线行为），绝不抛异常；tmp+rename 原子写。
 */
import { createBaselineIo } from './baseline';

/** 基线载荷：文件 → 规则 → 存量计数（与 @zh/refactor 的 countSmellsByFileAndRule 产出同构） */
export type RefactorBaselineCounts = Record<string, Record<string, number>>;

/** 落盘记录：version + capturedAt + counts 信封 */
export interface RefactorBaselineRecord {
  version: number;
  capturedAt: string;
  counts: RefactorBaselineCounts;
}

const REFACTOR_BASELINE_VERSION = 1;

// 刻意只做浅校验（与 baseline.ts 的 isBaselineEntries 同策略）：深层校验会改变既有降级行为
function isRefactorBaselineCounts(value: unknown): value is RefactorBaselineCounts {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.values(record).every(
    (rules) =>
      typeof rules === 'object' &&
      rules !== null &&
      Object.values(rules as Record<string, unknown>).every((n) => typeof n === 'number'),
  );
}

const refactorBaselineIo = createBaselineIo<RefactorBaselineRecord, RefactorBaselineCounts>({
  fileName: 'refactor-baseline.json',
  version: REFACTOR_BASELINE_VERSION,
  payloadKey: 'counts',
  isPayload: isRefactorBaselineCounts,
  buildRecord: (capturedAt, counts) => ({
    version: REFACTOR_BASELINE_VERSION,
    capturedAt,
    counts,
  }),
  warnTag: 'refactor-baseline',
});

/** 重构基线文件路径：<projectRoot>/.zhshield/refactor-baseline.json */
export function refactorBaselinePath(projectRoot: string): string {
  return refactorBaselineIo.path(projectRoot);
}

/** 读取重构基线；文件缺失 / 版本不符 / 损坏 → null（降级为无基线=全量报告行为） */
export function loadRefactorBaseline(
  projectRoot: string,
): Promise<RefactorBaselineCounts | null> {
  return refactorBaselineIo.load(projectRoot).then((r) => (r === null ? null : r.counts));
}

/** 写入重构基线（tmp+rename 原子替换），返回落盘记录 */
export function saveRefactorBaseline(
  projectRoot: string,
  counts: RefactorBaselineCounts,
): Promise<RefactorBaselineRecord> {
  return refactorBaselineIo.save(projectRoot, counts);
}

/** 清除重构基线文件；文件不存在时静默成功 */
export function clearRefactorBaseline(projectRoot: string): Promise<void> {
  return refactorBaselineIo.clear(projectRoot);
}

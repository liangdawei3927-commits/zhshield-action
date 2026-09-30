/**
 * 删除授权策略 —— 本域唯一的"什么可以被删除"事实源。
 *
 * 检测器只负责"发现"，授权一律由本模块判定：cleaner（主进程执行）与
 * 页面全选（渲染进程勾选）共用同一口径，避免"界面可选 = 后端可删"这类漂移。
 *
 * 授权标准只有一条：能否证明目标可再生成。据此二分：
 *   · 可删 —— 构建产物目录（整棵子树都是产物）与明确的垃圾文件；
 *   · 不可删 —— 死代码 / 重复代码 / 未用依赖。它们是 ts-prune / jscpd / depcheck
 *     的分析结论而非文件事实，误报率高且需人工判断，批量删除会直接销毁活源码
 *     （回归锁 clean-never-moves-source）。
 */
import type { GarbageType } from './types';
import { isJunkFileName, isRegenerablePath } from './junk-rules';

/** 需人工判断的分析结论：可导航、不可批量删除 */
const REVIEW_ONLY_TYPES: readonly GarbageType[] = ['dead-code', 'duplicate-code', 'unused-dependency'];

const ALL_GARBAGE_TYPES: readonly GarbageType[] = [
  'unused-file',
  'unused-dependency',
  'dead-code',
  'duplicate-code',
  'build-artifact',
];

/** 类型守卫：字符串是否为已知垃圾类型（用于过滤外部输入的未知类型） */
export function isKnownGarbageType(value: string): value is GarbageType {
  return (ALL_GARBAGE_TYPES as readonly string[]).includes(value);
}

/** 该类型的结论是否可被证明可再生 */
export function isDeletableType(type: GarbageType): boolean {
  return !(REVIEW_ONLY_TYPES as readonly string[]).includes(type);
}

/**
 * 白名单式路径授权：命中可再生目录名或垃圾文件名才放行。
 *
 * 采用白名单而非黑名单 —— 源码路径（`src/index.ts` 等）既不属产物目录、
 * 也不匹配垃圾特征，因此结构上无法通过，与调用方传入的 type 无关。
 */
export function isDeletablePath(relativePath: string): boolean {
  if (isRegenerablePath(relativePath)) return true;
  const name = relativePath.split('/').filter((segment) => segment.length > 0).pop();
  return name !== undefined && isJunkFileName(name);
}

/** 候选项最小结构：仅需类型与相对路径即可完成删除授权判定 */
export interface DeletableCandidate {
  readonly type: string;
  readonly path: string;
}

/**
 * 单项删除授权判定：类型已知 + 类型可再生 + 路径命中白名单，三者同时成立才可删。
 * @param item 垃圾候选项（类型 + 相对路径）
 * @returns 是否授权删除
 */
export function isDeletableItem(item: DeletableCandidate): boolean {
  return isKnownGarbageType(item.type) && isDeletableType(item.type) && isDeletablePath(item.path);
}

/** 删除授权二分结果：可安全删除 vs 待人工判断 */
export interface DeletablePartition<T> {
  readonly deletable: readonly T[];
  readonly reviewOnly: readonly T[];
}

/** 页面与清理器共用的二分：可删 / 待人工判断 */
export function partitionByDeletability<T extends DeletableCandidate>(
  items: readonly T[],
): DeletablePartition<T> {
  const deletable: T[] = [];
  const reviewOnly: T[] = [];
  for (const item of items) {
    (isDeletableItem(item) ? deletable : reviewOnly).push(item);
  }
  return { deletable, reviewOnly };
}

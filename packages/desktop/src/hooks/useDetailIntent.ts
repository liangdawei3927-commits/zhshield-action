import { useEffect, useRef } from 'react';
import { takeDetailIntent } from './nav-detail-intent';

/**
 * 页面挂载时若存在指向本页的「直达详情」意图，执行一次 `onIntent`。
 *
 * 只在挂载时判定（依赖 `page`）：意图是「本次跳转」的语义，不是页面常驻状态。
 * 若做成常驻布尔值，用户从详情点了返回主页后，任何一次重渲染都可能再被弹进详情。
 *
 * `onIntent` 用 ref 持有：页面传进来的多是内联箭头函数（如 `() => setShowHome(false)`），
 * 每次渲染都是新引用，直接进依赖数组会让 effect 空转、并把意图重复消费。
 */
export function useDetailIntentEffect(page: string, onIntent: () => void): void {
  const handlerRef = useRef(onIntent);
  handlerRef.current = onIntent;
  useEffect(() => {
    if (takeDetailIntent(page)) handlerRef.current();
  }, [page]);
}

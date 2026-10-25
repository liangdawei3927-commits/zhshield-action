import { useEffect, useRef } from 'react';

/**
 * 把「每次渲染都是新引用」的回调/值挂到 ref 上，供只依赖数据的 effect 使用。
 *
 * 页面里的回调多是内联箭头函数（每次渲染都是新引用）。直接进 effect 依赖会让
 * effect 在每次父组件重渲染时空转；用 ref 持有后，effect 只依赖真正驱动行为的
 * 数据（报告、loading 之类），语义更接近「数据变了才做事」。
 *
 * 收敛成独立模块的原因：域详情入口（`useDomainDetailEntry`）与扫描结束判据
 * （`useScanResultEntry`）都需要它，各写一份就成了同一段代码的第二份副本。
 */
export function useLatestRef<T>(value: T): { current: T } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

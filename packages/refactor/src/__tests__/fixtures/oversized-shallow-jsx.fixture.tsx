// fixture: 真实 JSX 深度仅 2 层，但含 TypeScript 泛型的组件
// 回归目标：detectOversizedComponent 不得把泛型(useState<Set<number>>)误判为 JSX 深度
import React, { useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface CounterProps {
  initial: number;
  labels: Map<string, string>;
}

export function CounterBadge({ initial, labels }: CounterProps): JSX.Element {
  const [count, setCount] = useState<number>(initial);
  const tracking = useRef<Set<number>>(new Set<number>());

  const bump = (): void => {
    const next = count + 1;
    tracking.current.add(next);
    setCount(next);
  };

  return (
    <div>
      <button onClick={bump}>{count}</button>
    </div>
  );
}

export function CounterBadgeAlternate({ initial, labels }: CounterProps): ReactNode {
  const [count, setCount] = useState<number>(initial);
  const bump = (): void => {
    setCount(count - 1);
  };

  return (
    <span>
      <em onClick={bump}>{labels.get(String(count)) ?? '—'}</em>
    </span>
  );
}

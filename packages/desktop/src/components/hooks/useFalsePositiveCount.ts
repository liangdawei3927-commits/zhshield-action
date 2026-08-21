import { useEffect, useState } from 'react';
import { listFalsePositives } from '../../services/engineApi';

export function useFalsePositiveCount(projectPath: string, source: 'guard' | 'sentinel'): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    listFalsePositives(projectPath, source)
      .then((records) => {
        if (!cancelled) setCount(records.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectPath, source]);
  return count;
}

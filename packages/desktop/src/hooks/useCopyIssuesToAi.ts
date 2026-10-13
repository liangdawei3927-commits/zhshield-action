import { useCallback } from 'react';
import { useToast } from '../components/ui/Toast';
import { copyIssuesToAi, type AiFixIssue } from '../utils/copyToAi';

/**
 * 单条 / 批量「复制到 AI」的通用接线：包住 toast 与空列表短路。
 *
 * 调用方只需提供「条目 → AiFixIssue」的映射函数，即可获得成对的
 * copyToAi / copyAllToAi，避免每个治理域各自重复同一段骨架。
 */
export function useCopyIssuesToAi<T>(
  projectPath: string,
  toAiIssue: (item: T) => AiFixIssue,
): {
  copyToAi: (item: T) => void;
  copyAllToAi: (items: readonly T[]) => void;
} {
  const { toast } = useToast();

  const copyToAi = useCallback(
    (item: T) => copyIssuesToAi(projectPath, toast, [toAiIssue(item)]),
    [projectPath, toast, toAiIssue],
  );

  const copyAllToAi = useCallback(
    (items: readonly T[]) => {
      if (items.length === 0) return;
      copyIssuesToAi(projectPath, toast, items.map(toAiIssue));
    },
    [projectPath, toast, toAiIssue],
  );

  return { copyToAi, copyAllToAi };
}

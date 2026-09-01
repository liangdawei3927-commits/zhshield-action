import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@zh/i18n';
import { runRefactor } from '../services/engineApi';
import type { RefactorReportData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';
import { useDailyAutoCheck } from '../hooks/useDailyAutoCheck';
import { useTaskRun } from '../task-store';

/** 单个代码异味条目（与 @zh/refactor 报告结构对齐） */
export type Smell = RefactorReportData['files'][number]['smells'][number];

/** 按 ruleId 聚合后的一个分类 */
export interface SmellGroup {
  ruleId: string;
  label: string;
  technique: string;
  items: Smell[];
}

/** ruleId → 分类名 i18n 键（与 @zh/refactor 检测器描述一致） */
const RULE_LABELS: Record<string, string> = {
  'long-method': 'page.refactor.smell.longMethod',
  'oversized-file': 'page.refactor.smell.oversizedFile',
  'long-parameter-list': 'page.refactor.smell.longParameterList',
  'mixed-responsibilities': 'page.refactor.smell.mixedResponsibilities',
  'deep-nesting': 'page.refactor.smell.deepNesting',
  'duplicated-code': 'page.refactor.smell.duplicatedCode',
  'callback-hell': 'page.refactor.smell.callbackHell',
  'shotgun-surgery': 'page.refactor.smell.shotgunSurgery',
  'data-class': 'page.refactor.smell.dataClass',
  'oversized-component': 'page.refactor.smell.oversizedComponent',
  'god-object': 'page.refactor.smell.godObject',
  'large-class': 'page.refactor.smell.largeClass',
  'feature-envy': 'page.refactor.smell.featureEnvy',
  'inappropriate-intimacy': 'page.refactor.smell.inappropriateIntimacy',
  'middle-man': 'page.refactor.smell.middleMan',
  'message-chains': 'page.refactor.smell.messageChains',
  'refused-bequest': 'page.refactor.smell.refusedBequest',
  'lazy-class': 'page.refactor.smell.lazyClass',
  'switch-statement': 'page.refactor.smell.switchStatement',
  'data-clumps': 'page.refactor.smell.dataClumps',
  'primitive-obsession': 'page.refactor.smell.primitiveObsession',
};

const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

export function groupSmellsByRule(files: RefactorReportData['files']): SmellGroup[] {
  const map = new Map<string, SmellGroup['items']>();
  for (const file of files) {
    for (const smell of file.smells) {
      const items = map.get(smell.ruleId) ?? [];
      items.push(smell);
      map.set(smell.ruleId, items);
    }
  }
  return Array.from(map.entries(), ([ruleId, items]) => {
    const first = items[0];
    return {
      ruleId,
      label: RULE_LABELS[ruleId] ?? first.suggestion.type ?? ruleId,
      technique: first.suggestion.type,
      items: items.sort(
        (a, b) =>
          (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
          (a.location?.line ?? 0) - (b.location?.line ?? 0),
      ),
    };
  }).sort(
    (a, b) =>
      b.items.length - a.items.length ||
      (SEVERITY_ORDER[a.items[0].severity] ?? 9) - (SEVERITY_ORDER[b.items[0].severity] ?? 9),
  );
}

export const SEVERITY_COLORS: Record<string, string> = {
  error: 'rgb(var(--zh-danger))',
  warning: 'rgb(var(--zh-warning))',
  info: 'rgb(var(--zh-info))',
};
export const SEVERITY_LABELS: Record<string, string> = {
  error: 'page.refactor.severity.error',
  warning: 'page.refactor.severity.warning',
  info: 'severity.info',
};

/** 复制重构问题到 AI：构建提示词并写入剪贴板 */
export function useCopyToAi(projectPath: string) {
  const { toast } = useToast();
  const copyIssues = useCallback(
    (issues: AiFixIssue[]) => {
      const text = buildAiFixPrompt(projectPath, issues);
      void copyTextToClipboard(text).then(
        (ok) => (ok ? toast(t('toast.copiedToAi')) : toast(t('toast.copyFailed'), 'error')),
        () => toast(t('toast.copyFailed'), 'error'),
      );
    },
    [projectPath, toast, t],
  );
  const toAiIssue = useCallback(
    (filePath: string, smell: Smell): AiFixIssue => ({
      source: t('page.refactor.source'),
      ruleId: smell.ruleId,
      severity: SEVERITY_LABELS[smell.severity]
        ? t(SEVERITY_LABELS[smell.severity])
        : smell.severity,
      file: filePath,
      line: smell.location?.line,
      message: smell.message,
      suggestion: smell.suggestion.description,
    }),
    [t],
  );
  const copyToAi = useCallback(
    (filePath: string, smell: Smell) => copyIssues([toAiIssue(filePath, smell)]),
    [copyIssues, toAiIssue],
  );
  const copyGroupToAi = useCallback(
    (group: SmellGroup) =>
      copyIssues(group.items.map((smell) => toAiIssue(smell.location.filePath, smell))),
    [copyIssues, toAiIssue],
  );
  return { copyToAi, copyGroupToAi };
}

/** 重构扫描执行：loading/进度来自任务中心，状态 + 手动扫描（防重入） */
export function useRefactorScan(projectPath: string) {
  const [report, setReport] = useState<RefactorReportData | null>(null);
  const [error, setError] = useState('');
  const scanningRef = useRef(false);
  const { loading: scanning, progressLabel } = useTaskRun('refactor', projectPath);
  const handleScan = useCallback(async () => {
    if (!projectPath) {
      setError(t('page.refactor.addProjectFirst'));
      return;
    }
    if (scanningRef.current) return;
    scanningRef.current = true;
    setError('');
    try {
      const result = await runRefactor(projectPath);
      setReport(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(t('page.refactor.scanFailed', { message: msg }));
    } finally {
      scanningRef.current = false;
    }
  }, [projectPath, t]);
  return { scanning, progressLabel, report, error, handleScan };
}

/** 按 ruleId 分类聚合 + 当前选中分类 */
export function useSmellGroups(report: RefactorReportData | null) {
  const [activeRuleId, setActiveRuleId] = useState('');
  const groups = useMemo(() => (report ? groupSmellsByRule(report.files) : []), [report]);
  const activeGroup = useMemo(
    () => groups.find((g) => g.ruleId === activeRuleId) ?? groups[0] ?? null,
    [groups, activeRuleId],
  );
  useEffect(() => {
    if (groups.length === 0) {
      setActiveRuleId('');
    } else if (!groups.some((g) => g.ruleId === activeRuleId)) {
      setActiveRuleId(groups[0].ruleId);
    }
  }, [groups, activeRuleId]);
  return { activeRuleId, setActiveRuleId, groups, activeGroup };
}

/** 重构页全部状态与副作用：扫描、每日自动检查、复制到 AI、分类聚合 */
export function useRefactorPage(projectPath: string) {
  const { copyToAi, copyGroupToAi } = useCopyToAi(projectPath);
  const { scanning, progressLabel, report, error, handleScan } = useRefactorScan(projectPath);
  const { lastAutoAt } = useDailyAutoCheck(projectPath, () => void handleScan());
  const { activeRuleId, setActiveRuleId, groups, activeGroup } = useSmellGroups(report);
  return {
    scanning,
    progressLabel,
    report,
    error,
    lastAutoAt,
    activeRuleId,
    setActiveRuleId,
    activeGroup,
    groups,
    copyToAi,
    copyGroupToAi,
    handleScan,
  };
}

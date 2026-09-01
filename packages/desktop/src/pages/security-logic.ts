import { useCallback, useState } from 'react';
import { t } from '@zh/i18n';
import { runSecurity } from '../services/engineApi';
import type { SecurityScanReportData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { buildAiFixPrompt, copyTextToClipboard, type AiFixIssue } from '../utils/copyToAi';
import { useTaskRun } from '../task-store';

export const SEVERITY_CONFIG: Record<string, { color: string; bg: string; labelKey: string }> = {
  critical: {
    color: 'rgb(var(--zh-danger-dark))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
    labelKey: 'severity.critical',
  },
  high: {
    color: 'rgb(var(--zh-danger))',
    bg: 'rgb(var(--zh-danger) / 0.1)',
    labelKey: 'severity.high',
  },
  medium: {
    color: 'rgb(var(--zh-warning))',
    bg: 'rgb(var(--zh-warning) / 0.1)',
    labelKey: 'severity.medium',
  },
  low: { color: 'rgb(var(--zh-info))', bg: 'rgb(var(--zh-info) / 0.1)', labelKey: 'severity.low' },
};

export const MALWARE_TYPE_LABEL: Record<string, string> = {
  'reverse-shell': 'page.security.malware.reverseShell',
  'data-exfiltration': 'page.security.malware.dataExfiltration',
  'privilege-escalation': 'page.security.malware.privilegeEscalation',
  'crypto-ransomware': 'page.security.malware.cryptoRansomware',
  backdoor: 'page.security.malware.backdoor',
  'supply-chain': 'page.security.malware.supplyChain',
  'suspicious-behavior': 'page.security.malware.suspiciousBehavior',
};

export interface SecurityIssue {
  id: string;
  severity: string;
  file: string;
  line?: number;
  title: string;
  description: string;
  recommendation?: string;
}

/** 安全扫描运行：loading/进度来自任务中心，状态 + 报告 */
function useSecurityRun(projectPath: string): {
  loading: boolean;
  progressLabel: string;
  report: SecurityScanReportData | null;
  handleScan: () => Promise<void>;
} {
  const [report, setReport] = useState<SecurityScanReportData | null>(null);
  const { loading, progressLabel } = useTaskRun('security', projectPath);

  const handleScan = useCallback(async () => {
    try {
      const result = await runSecurity(projectPath);
      setReport(result);
    } catch {
      setReport(null);
    }
  }, [projectPath]);

  return { loading, progressLabel, report, handleScan };
}

/** 复制单个发现到 AI 修复 */
function toAiIssue(issue: SecurityIssue): AiFixIssue {
  return {
    source: t('page.security.source'),
    ruleId: issue.id,
    severity: t(SEVERITY_CONFIG[issue.severity]?.labelKey ?? issue.severity),
    file: issue.file,
    line: issue.line,
    message: `${issue.title} — ${issue.description}`,
    suggestion: issue.recommendation,
  };
}

function copyIssuesToAi(
  projectPath: string,
  issues: AiFixIssue[],
  toast: (msg: string, variant?: 'success' | 'error' | 'warning' | 'info') => void,
): void {
  const text = buildAiFixPrompt(projectPath, issues);
  void copyTextToClipboard(text).then(
    (ok) => (ok ? toast(t('toast.copiedToAi')) : toast(t('toast.copyFailed'), 'error')),
    () => toast(t('toast.copyFailed'), 'error'),
  );
}

function useSecurityCopyToAi(projectPath: string): {
  copyToAi: (issue: SecurityIssue) => void;
  copyAllToAi: (issues: SecurityIssue[]) => void;
} {
  const { toast } = useToast();

  const copyToAi = useCallback(
    (issue: SecurityIssue) => copyIssuesToAi(projectPath, [toAiIssue(issue)], toast),
    [projectPath, toast],
  );

  const copyAllToAi = useCallback(
    (issues: SecurityIssue[]) => {
      if (issues.length === 0) return;
      copyIssuesToAi(projectPath, issues.map(toAiIssue), toast);
    },
    [projectPath, toast],
  );

  return { copyToAi, copyAllToAi };
}

export function useSecurityPage(projectPath: string) {
  const { loading, progressLabel, report, handleScan } = useSecurityRun(projectPath);
  const { copyToAi, copyAllToAi } = useSecurityCopyToAi(projectPath);

  return { loading, progressLabel, report, copyToAi, copyAllToAi, handleScan };
}

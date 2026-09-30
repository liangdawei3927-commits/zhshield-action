import { useCallback, useState } from 'react';
import { t } from '@zh/i18n';
import { runSecurity } from '../services/engineApi';
import type { SecurityScanReportData } from '../types/electron';
import { useToast } from '../components/ui/Toast';
import { copyIssuesToAi, type AiFixIssue } from '../utils/copyToAi';
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

/** 安全页展示的问题条目（漏洞/恶意代码归一）：严重级别、位置与修复建议 */
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
  progress: number;
  progressLabel: string;
  statusMessage: string;
  report: SecurityScanReportData | null;
  handleScan: () => Promise<void>;
} {
  const [report, setReport] = useState<SecurityScanReportData | null>(null);
  const { loading, progress, progressLabel, statusMessage } = useTaskRun('security', projectPath);

  const handleScan = useCallback(async () => {
    try {
      const result = await runSecurity(projectPath);
      setReport(result);
    } catch {
      setReport(null);
    }
  }, [projectPath]);

  return { loading, progress, progressLabel, statusMessage, report, handleScan };
}

/** 漏洞发现 → vuln 域（修复动作：修补缺陷本身） */
function toAiIssue(issue: SecurityIssue): AiFixIssue {
  return {
    source: t('page.security.source'),
    ruleId: issue.id,
    severity: t(SEVERITY_CONFIG[issue.severity]?.labelKey ?? issue.severity),
    file: issue.file,
    line: issue.line,
    message: `${issue.title} — ${issue.description}`,
    suggestion: issue.recommendation,
    domain: 'vuln',
  };
}

/** 恶意代码条目 → malware 域（修复动作：移除/隔离载荷，非修补） */
function toMalwareAiIssue(item: SecurityScanReportData['malware'][number]): AiFixIssue {
  return {
    source: t('page.security.source'),
    ruleId: item.id,
    severity: t(SEVERITY_CONFIG[item.severity]?.labelKey ?? item.severity),
    file: item.file,
    line: item.line,
    message: `${item.title} — ${item.description}（pattern: ${item.pattern}）`,
    suggestion: item.evidence,
    domain: 'malware',
  };
}

/** 漏洞条目 → AI 修复（vuln 域） */
function useVulnCopyToAi(projectPath: string): {
  copyToAi: (issue: SecurityIssue) => void;
  copyAllToAi: (issues: SecurityIssue[]) => void;
} {
  const { toast } = useToast();
  const copyToAi = useCallback(
    (issue: SecurityIssue) => copyIssuesToAi(projectPath, toast, [toAiIssue(issue)]),
    [projectPath, toast],
  );
  const copyAllToAi = useCallback(
    (issues: SecurityIssue[]) => {
      if (issues.length === 0) return;
      copyIssuesToAi(projectPath, toast, issues.map(toAiIssue));
    },
    [projectPath, toast],
  );
  return { copyToAi, copyAllToAi };
}

/** 恶意代码条目 → AI 修复（malware 域） */
function useMalwareCopyToAi(projectPath: string): {
  copyMalwareToAi: (item: SecurityScanReportData['malware'][number]) => void;
  copyMalwareAllToAi: (items: SecurityScanReportData['malware']) => void;
} {
  const { toast } = useToast();
  const copyMalwareToAi = useCallback(
    (item: SecurityScanReportData['malware'][number]) =>
      copyIssuesToAi(projectPath, toast, [toMalwareAiIssue(item)]),
    [projectPath, toast],
  );
  const copyMalwareAllToAi = useCallback(
    (items: SecurityScanReportData['malware']) => {
      if (items.length === 0) return;
      copyIssuesToAi(projectPath, toast, items.map(toMalwareAiIssue));
    },
    [projectPath, toast],
  );
  return { copyMalwareToAi, copyMalwareAllToAi };
}

function useSecurityCopyToAi(projectPath: string): {
  copyToAi: (issue: SecurityIssue) => void;
  copyAllToAi: (issues: SecurityIssue[]) => void;
  copyMalwareToAi: (item: SecurityScanReportData['malware'][number]) => void;
  copyMalwareAllToAi: (items: SecurityScanReportData['malware']) => void;
} {
  const { copyToAi, copyAllToAi } = useVulnCopyToAi(projectPath);
  const { copyMalwareToAi, copyMalwareAllToAi } = useMalwareCopyToAi(projectPath);

  return { copyToAi, copyAllToAi, copyMalwareToAi, copyMalwareAllToAi };
}

export function useSecurityPage(projectPath: string) {
  const { loading, progress, progressLabel, statusMessage, report, handleScan } =
    useSecurityRun(projectPath);
  const { copyToAi, copyAllToAi, copyMalwareToAi, copyMalwareAllToAi } =
    useSecurityCopyToAi(projectPath);

  return {
    loading,
    progress,
    progressLabel,
    statusMessage,
    report,
    copyToAi,
    copyAllToAi,
    copyMalwareToAi,
    copyMalwareAllToAi,
    handleScan,
  };
}

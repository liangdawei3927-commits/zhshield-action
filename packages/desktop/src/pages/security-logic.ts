import { useState } from 'react';
import { t } from '@zh/i18n';
import { runSecurity } from '../services/engineApi';
import type { SecurityScanReportData } from '../types/electron';
import { useCopyIssuesToAi } from '../hooks/useCopyIssuesToAi';
import { useRunWithReport } from '../hooks/useRunWithReport';
import type { AiFixIssue } from '../utils/copyToAi';
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
  statusMessage: string;
  /** 任务已入队但还没真正开始（按钮显示「排队中…」） */
  /** 取消当前任务（用户点「停止」）：主进程立刻让等待方返回，UI 不等执行器收尾 */
  cancel: () => void;
  /** 已发出取消、等任务中心确认（按钮显示「停止中…」并禁用） */
  stopping: boolean;
  queued: boolean;
  /** 排队位置（1 起；仅 queued 时有值） */
  queuePosition?: number;
  report: SecurityScanReportData | null;
  handleScan: () => Promise<void>;
} {
  const [report, setReport] = useState<SecurityScanReportData | null>(null);
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping } = useTaskRun('security', projectPath);
  const { handleScan } = useRunWithReport(projectPath, runSecurity, setReport);

  return { loading, progress, statusMessage, queued, queuePosition, cancel, stopping, report, handleScan };
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

function useSecurityCopyToAi(projectPath: string): {
  copyToAi: (issue: SecurityIssue) => void;
  copyAllToAi: (issues: SecurityIssue[]) => void;
  copyMalwareToAi: (item: SecurityScanReportData['malware'][number]) => void;
  copyMalwareAllToAi: (items: SecurityScanReportData['malware']) => void;
} {
  const { copyToAi, copyAllToAi } = useCopyIssuesToAi(projectPath, toAiIssue);
  const { copyToAi: copyMalwareToAi, copyAllToAi: copyMalwareAllToAi } =
    useCopyIssuesToAi(projectPath, toMalwareAiIssue);

  return { copyToAi, copyAllToAi, copyMalwareToAi, copyMalwareAllToAi };
}

export function useSecurityPage(projectPath: string) {
  const { loading, progress, statusMessage, queued, queuePosition, cancel, stopping, report, handleScan } =
    useSecurityRun(projectPath);
  const { copyToAi, copyAllToAi, copyMalwareToAi, copyMalwareAllToAi } =
    useSecurityCopyToAi(projectPath);

  return {
    loading,
    progress,
    statusMessage,
    queued,
    queuePosition,
    cancel,
    stopping,
    report,
    copyToAi,
    copyAllToAi,
    copyMalwareToAi,
    copyMalwareAllToAi,
    handleScan,
  };
}

/**
 * 「复制到AI」共享工具：把检查出的问题格式化成可直接粘贴给 AI 编程工具
 * （opencode 等）的修复提示词。所有结果页（门禁/巡检/安全/重构…）共用
 * 清单结构，但「处理要求」段按语义域（domain）分发——每类问题的修复
 * 动作不同（改代码 / 删除 / 轮换凭证 / 移除恶意载荷…），通用废话提示词
 * 无法让 AI 执行正确的动作。无 domain / 未知 domain 回退通用要求，保证
 * 任何页面复制出来的提示词都可读。
 */
import { t } from '@zh/i18n';

/**
 * 已知语义域：与「复制到AI」各调用点一一对应，决定提示词要求段。
 * 粒度按「修复动作」而非页面：安全页拆出 vuln / malware / secrets 三域，
 * 因为三者的修复动作完全不同。
 */
export const AI_FIX_DOMAINS = [
  'guard',
  'inspect',
  'sentinel',
  'vuln',
  'malware',
  'secrets',
  'deps',
  'garbage',
  'performance',
  'techdebt',
  'refactor',
] as const;

/** 已知语义域（按修复动作划分，决定提示词「处理要求」段） */
export type AiFixDomain = (typeof AI_FIX_DOMAINS)[number];

/** 「复制到AI」清单条目：各结果页归一后的问题描述（来源、规则、位置、建议、语义域） */
export interface AiFixIssue {
  /** 来源标签，如 门禁·预防 / 巡检 / 安全 / 重构 */
  source: string;
  ruleId: string;
  severity?: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
  /** 语义域标识（AiFixDomain）；缺省时使用通用要求段 */
  domain?: string;
}

function isKnownDomain(domain: string): domain is AiFixDomain {
  return (AI_FIX_DOMAINS as readonly string[]).includes(domain);
}

/** 通用要求段（无 domain / 未知域兜底） */
function pushGenericRequirements(lines: string[]): void {
  lines.push(t('ai.copyFix.requirementsTitle'));
  lines.push(t('ai.copyFix.requirement1'));
  lines.push(t('ai.copyFix.requirement2'));
  lines.push(t('ai.copyFix.requirement3'));
  lines.push(t('ai.copyFix.requirement4'));
  lines.push(t('ai.copyFix.requirement5'));
}

/** 按语义域分发要求段；未知域回退通用要求 */
function pushDomainRequirements(lines: string[], domain: string): void {
  if (!isKnownDomain(domain)) {
    pushGenericRequirements(lines);
    return;
  }
  lines.push(t(`ai.copyFix.domainRequirements.${domain}.title`));
  for (let i = 1; i <= 4; i += 1) {
    lines.push(t(`ai.copyFix.domainRequirements.${domain}.r${i}`));
  }
  lines.push('');
}

export function buildAiFixPrompt(projectPath: string, issues: readonly AiFixIssue[]): string {
  const lines: string[] = [t('ai.copyFix.promptIntro'), ''];
  issues.forEach((issue, index) => {
    lines.push(t('ai.copyFix.issueHeader', { number: index + 1, source: issue.source }));
    lines.push(t('ai.copyFix.ruleLabel', { ruleId: issue.ruleId }));
    if (issue.severity) lines.push(t('ai.copyFix.severityLabel', { severity: issue.severity }));
    const location = [issue.file, issue.line, issue.column].filter((v) => v != null).join(':');
    if (location) lines.push(t('ai.copyFix.locationLabel', { location }));
    lines.push(t('ai.copyFix.messageLabel', { message: issue.message }));
    if (issue.suggestion)
      lines.push(t('ai.copyFix.suggestionLabel', { suggestion: issue.suggestion }));
    lines.push('');
  });
  lines.push(t('ai.copyFix.projectPathLabel', { projectPath }));
  lines.push(t('ai.copyFix.toolHint'));
  // 按语义域去重（保持首次出现顺序）分发要求段
  const domains = [
    ...new Set(issues.map((issue) => issue.domain).filter((d): d is string => d != null)),
  ];
  if (domains.length === 0) {
    pushGenericRequirements(lines);
  } else {
    for (const domain of domains) {
      pushDomainRequirements(lines, domain);
    }
  }
  return lines.join('\n');
}

function legacyCopyViaExecCommand(text: string): boolean {
  try {
    if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒 / 文档失焦等场景，走 execCommand 降级
  }
  return legacyCopyViaExecCommand(text);
}

/** 轻提示回调签名（文案 + 可选样式变体） */
export type ToastFn = (message: string, variant?: 'success' | 'error' | 'warning' | 'info') => void;

export function copyIssuesToAi(
  projectPath: string,
  toast: ToastFn,
  issues: readonly AiFixIssue[],
): void {
  const text = buildAiFixPrompt(projectPath, issues);
  void copyTextToClipboard(text).then(
    (ok) => (ok ? toast(t('toast.issuesCopied')) : toast(t('toast.copyFailed'), 'error')),
    () => toast(t('toast.copyFailed'), 'error'),
  );
}

/**
 * 「复制到AI」共享工具：把检查出的问题格式化成可直接粘贴给 AI 编程工具
 * （opencode 等）的修复提示词。所有结果页（门禁/巡检/安全/重构）共用，
 * 保证提示词格式一致。
 */
import { t } from '@zh/i18n';

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
  lines.push(t('ai.copyFix.requirementsTitle'));
  lines.push(t('ai.copyFix.requirement1'));
  lines.push(t('ai.copyFix.requirement2'));
  lines.push(t('ai.copyFix.requirement3'));
  lines.push(t('ai.copyFix.requirement4'));
  lines.push(t('ai.copyFix.requirement5'));
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

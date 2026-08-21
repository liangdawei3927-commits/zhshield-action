/**
 * 体检后自动触发 OpenCode 修复（纯函数部分，无 Electron 依赖，可单测）。
 * 触发链路：诊断落盘 → shouldAutoFix 判断 → main.ts spawn `opencode run`。
 *
 * 触发策略：
 * - 门禁（guard）是「预防」层，发现问题只做人工决策，**不自动触发** AI 编程；
 *   用户仍可在门禁页手动「复制到AI」交给 AI 修复。
 * - 巡检（inspect）/ 重构（refactor）等「检查」类问题存在 error/warning 时才自动触发。
 */
import { join } from 'node:path';
import { t } from '@zh/i18n';

export interface AutoFixReport {
  summary: { error: number; warning: number };
  /** 归一化诊断条目；每个条目带 source: 'guard' | 'inspect' | 'refactor' */
  issues?: ReadonlyArray<{ source?: string; severity?: string }>;
}

/**
 * 是否需要自动触发 AI 修复：
 * - 有 issues 明细时，只看非 guard（非预防）来源的 error/warning；
 * - 旧格式诊断文件无 issues 时，回退到 summary 计数判断。
 */
export function shouldAutoFix(report: AutoFixReport): boolean {
  if (report.issues) {
    return report.issues.some(
      (issue) => issue.source !== 'guard' && (issue.severity === 'error' || issue.severity === 'warning'),
    );
  }
  return report.summary.error > 0 || report.summary.warning > 0;
}

export function countFixableIssues(report: AutoFixReport): { error: number; warning: number } {
  if (report.issues && report.issues.length > 0) {
    const fixable = report.issues.filter((issue) => issue.source !== 'guard');
    return {
      error: fixable.filter((issue) => issue.severity === 'error').length,
      warning: fixable.filter((issue) => issue.severity === 'warning').length,
    };
  }
  return { error: report.summary.error, warning: report.summary.warning };
}

/** 生成交给 OpenCode agent 的修复指令（cwd 为项目根，提示词指向诊断文件） */
export function buildFixPrompt(projectPath: string): string {
  const diagPath = join(projectPath, '.zhshield', 'diagnostics', 'latest.json');
  return [
    t('ai.autoFix.promptIntro'),
    t('ai.autoFix.readDiagnostics', { diagPath }),
    t('ai.autoFix.requirementsTitle'),
    t('ai.autoFix.requirement1'),
    t('ai.autoFix.requirement2'),
    t('ai.autoFix.requirement3'),
    t('ai.autoFix.requirement4'),
    t('ai.autoFix.requirement5'),
    t('ai.autoFix.requirement6'),
  ].join('\n');
}

/** 解析 opencode CLI 可执行文件路径：环境变量优先，其次候选列表，找不到返回 null */
export function resolveOpenCodeBin(
  envBin: string | undefined,
  candidates: ReadonlyArray<{ path: string; executable: boolean }>,
): string | null {
  if (envBin && candidates.some((c) => c.path === envBin && c.executable)) {
    return envBin;
  }
  for (const candidate of candidates) {
    if (candidate.executable) return candidate.path;
  }
  return null;
}

/** CLI 子进程默认模型：opencode 默认模型可能是当前会话专用路由，子进程必须显式指定模型 */
export const DEFAULT_OPENCODE_MODEL = 'opencode/deepseek-v4-flash-free';

export function resolveOpenCodeModel(envModel: string | undefined): string {
  return envModel && envModel.trim() !== '' ? envModel.trim() : DEFAULT_OPENCODE_MODEL;
}

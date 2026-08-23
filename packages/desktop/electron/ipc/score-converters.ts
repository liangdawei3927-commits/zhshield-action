/**
 * SOP 评估 → 内部报告格式的纯转换函数。
 *
 * 刻意放在 electron/ipc 下但**不依赖 electron**，以便 vitest 直接单测，
 * 而不用加载主进程 IPC 模块。引擎层 engines.ts 与本文件测试都从这里导入。
 */

/** 从 SOP RuleEvaluation 抽取文件路径（files[0] 优先，回退到首条违规的 file），用于模块级分桶 */
function firstFileOf(ev: { files?: string[]; violations?: Array<{ file?: string }> }): string | undefined {
  return ev.files?.[0] ?? ev.violations?.[0]?.file;
}

export function convertGuardEvaluations(evaluations: unknown[]): Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean; file?: string }> {
  return evaluations.map((ev) => {
    const e = ev as { status?: string; rule?: { severity?: string }; files?: string[]; violations?: Array<{ file?: string }> };
    const statusMap: Record<string, 'passed' | 'failed' | 'error' | 'warning'> = {
      passed: 'passed',
      failed: 'failed',
      error: 'error',
      skipped: 'warning',
    };
    const severityMap: Record<string, 'error' | 'warning' | 'info'> = {
      critical: 'error',
      high: 'error',
      medium: 'warning',
      low: 'info',
      info: 'info',
    };
    return {
      severity: severityMap[e.rule?.severity ?? ''] ?? 'warning',
      status: statusMap[e.status ?? ''] ?? 'error',
      blocking: e.status === 'failed',
      file: firstFileOf(e),
    };
  });
}

export function convertInspectEvaluations(evaluations: unknown[]): Array<{ severity: 'error' | 'warning' | 'info'; category: string; file?: string }> {
  return evaluations
    .filter((ev) => {
      const s = (ev as { status?: string }).status;
      return s !== 'passed' && s !== 'skipped';
    })
    .map((ev) => {
      const e = ev as { status?: string; rule?: { severity?: string; tags?: string[] }; files?: string[]; violations?: Array<{ file?: string }> };
      const severityMap: Record<string, 'error' | 'warning' | 'info'> = {
        critical: 'error',
        high: 'error',
        medium: 'warning',
        low: 'info',
        info: 'info',
      };
      const tags = e.rule?.tags ?? [];
      let category = 'quality';
      if (tags.includes('security')) category = 'security';
      else if (tags.includes('performance')) category = 'performance';
      else if (tags.includes('documentation')) category = 'documentation';
      else if (tags.includes('dependency')) category = 'dependency';
      else if (tags.includes('test')) category = 'test';
      else if (tags.includes('architecture') || tags.includes('refactoring')) category = 'architecture';

      return {
        severity: severityMap[e.rule?.severity ?? ''] ?? 'warning',
        category,
        file: firstFileOf(e),
      };
    });
}

/**
 * SOP 评估 → 内部报告格式的纯转换函数。
 *
 * 刻意放在 electron/ipc 下但**不依赖 electron**，以便 vitest 直接单测，
 * 而不用加载主进程 IPC 模块。引擎层 engines.ts 与本文件测试都从这里导入。
 */

export function convertGuardEvaluations(evaluations: unknown[]): Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean }> {
  return evaluations.map((ev) => {
    const e = ev as { status?: string; rule?: { severity?: string } };
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
    };
  });
}

export function convertInspectEvaluations(evaluations: unknown[]): Array<{ severity: 'error' | 'warning' | 'info'; category: string }> {
  return evaluations
    .filter((ev) => {
      const s = (ev as { status?: string }).status;
      return s !== 'passed' && s !== 'skipped';
    })
    .map((ev) => {
      const e = ev as { status?: string; rule?: { severity?: string; tags?: string[] } };
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
      };
    });
}

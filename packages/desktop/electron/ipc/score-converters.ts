import type { CheckResult } from '@zh/guard';

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

/**
 * 传统（非 SOP）门禁结果 → 模块分桶输入。
 *
 * 传统模式下 guard.CheckResult 聚合了整个检查（如 ESLint 一次扫描跨多文件），
 * 本身没有 file 字段，导致 bucketFindingsByModule 把所有 finding 归入根级兜底模块，
 * 而非正确的 monorepo 子模块。这里按 details 中携带的文件路径把聚合结果拆成逐文件结果，
 * 使其能正确归属到子模块：
 * - ESLint 适配器：details.errors / details.warnings 为字符串数组，每条形如 `[ruleId] msg (filePath:line:col)`
 * - 敏感信息适配器：details.findings 为 `{ file, ... }[]`
 * 其它无法定位到文件的检查保持单条（落入根模块），行为与原先一致。
 */
export function convertTraditionalGuardResults(
  results: CheckResult[],
): Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean; file?: string }> {
  const out: Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean; file?: string }> = [];
  for (const r of results) out.push(...explodeTraditionalResult(r));
  return out;
}

function eslintFileOf(s: string): string | undefined {
  const m = s.match(/\((.+):\d+:\d+\)$/);
  return m ? m[1] : undefined;
}

function explodeTraditionalResult(r: CheckResult): Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean; file?: string }> {
  if (r.status === 'passed') return [{ severity: 'info', status: 'passed', blocking: false }];

  const d = r.details as
    | { errors?: string[]; warnings?: string[]; findings?: Array<{ file?: string }> }
    | undefined;

  const exploded: Array<{ severity: 'error' | 'warning' | 'info'; status: 'passed' | 'failed' | 'error' | 'warning'; blocking: boolean; file?: string }> = [];

  if (d && Array.isArray(d.errors)) {
    for (const s of d.errors) {
      const f = eslintFileOf(s);
      if (f) exploded.push({ severity: 'error', status: 'failed', blocking: r.blocking, file: f });
    }
  }
  if (d && Array.isArray(d.warnings)) {
    for (const s of d.warnings) {
      const f = eslintFileOf(s);
      if (f) exploded.push({ severity: 'warning', status: 'warning', blocking: false, file: f });
    }
  }
  if (d && Array.isArray(d.findings) && exploded.length === 0) {
    for (const f of d.findings) {
      if (f && typeof f.file === 'string' && f.file) {
        exploded.push({ severity: r.severity, status: r.status, blocking: r.blocking, file: f.file });
      }
    }
  }

  if (exploded.length > 0) return exploded;
  // 无法定位到文件：保持单条，落入根模块（与原行为一致）
  return [{ severity: r.severity, status: r.status, blocking: r.blocking }];
}

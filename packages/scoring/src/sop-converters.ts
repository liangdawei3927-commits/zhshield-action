/**
 * SOP 评估 → 内部报告格式的纯转换函数（@zh/scoring 共享包）。
 *
 * 桌面端（electron/ipc/score-converters.ts）与服务端（packages/server）共用，
 * 避免两份实现漂移。刻意不依赖 electron / @zh/guard，只依赖结构兼容的最小类型。
 */

/** 传统（非 SOP）门禁 CheckResult 的最小结构 — 与 @zh/guard CheckResult 字段兼容 */
export interface GuardCheckResultLike {
  severity: 'error' | 'warning' | 'info';
  status: 'passed' | 'failed' | 'error' | 'warning';
  blocking: boolean;
  details?: unknown;
}

/** 转换后的 guard 结果（模块分桶 / 评分输入共用） */
export type ConvertedGuardResult = {
  severity: 'error' | 'warning' | 'info';
  status: 'passed' | 'failed' | 'error' | 'warning';
  blocking: boolean;
  file?: string;
};

/** 转换后的 inspect 问题 */
export type ConvertedInspectIssue = {
  severity: 'error' | 'warning' | 'info';
  category: string;
  file?: string;
};

const ESLINT_FILE_RE = /\((.+):\d+:\d+\)$/;

/** 标签 → 分类的优先级映射（数组顺序即优先级，与原先 if/else-if 链一致） */
const CATEGORY_PRIORITY: ReadonlyArray<readonly [readonly string[], string]> = [
  [['security'], 'security'],
  [['performance'], 'performance'],
  [['documentation'], 'documentation'],
  [['dependency'], 'dependency'],
  [['test'], 'test'],
  [['architecture', 'refactoring'], 'architecture'],
];

function categoryOf(tags: string[]): string {
  for (const [matchTags, category] of CATEGORY_PRIORITY) {
    if (matchTags.some((t) => tags.includes(t))) return category;
  }
  return 'quality';
}

/** 从 SOP RuleEvaluation 抽取文件路径（files[0] 优先，回退到首条违规的 file），用于模块级分桶 */
function firstFileOf(ev: { files?: string[]; violations?: Array<{ file?: string }> }): string | undefined {
  return ev.files?.[0] ?? ev.violations?.[0]?.file;
}

export function convertGuardEvaluations(evaluations: unknown[]): ConvertedGuardResult[] {
  // 工具未安装的跳过项不应扣分，与 convertInspectEvaluations 保持一致
  return evaluations
    .filter((ev) => (ev as { status?: string }).status !== 'skipped')
    .map((ev) => {
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

export function convertInspectEvaluations(evaluations: unknown[]): ConvertedInspectIssue[] {
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
      const category = categoryOf(tags);

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
export function convertTraditionalGuardResults(results: GuardCheckResultLike[]): ConvertedGuardResult[] {
  const out: ConvertedGuardResult[] = [];
  for (const r of results) out.push(...explodeTraditionalResult(r));
  return out;
}

function eslintFileOf(s: string): string | undefined {
  const m = s.match(ESLINT_FILE_RE);
  return m ? m[1] : undefined;
}

function explodeTraditionalResult(r: GuardCheckResultLike): ConvertedGuardResult[] {
  if (r.status === 'passed') return [{ severity: 'info', status: 'passed', blocking: false }];

  const d = r.details as
    | { errors?: string[]; warnings?: string[]; findings?: Array<{ file?: string }> }
    | undefined;
  const exploded: ConvertedGuardResult[] = [
    ...explodeErrors(d, r),
    ...explodeWarnings(d),
  ];
  if (exploded.length === 0) {
    exploded.push(...explodeFindings(d, r));
  }

  if (exploded.length > 0) return exploded;
  // 无法定位到文件：保持单条，落入根模块（与原行为一致）
  return [{ severity: r.severity, status: r.status, blocking: r.blocking }];
}

function explodeErrors(d: { errors?: string[] } | undefined, r: GuardCheckResultLike): ConvertedGuardResult[] {
  if (!d || !Array.isArray(d.errors)) return [];
  const exploded: ConvertedGuardResult[] = [];
  for (const s of d.errors) {
    const f = eslintFileOf(s);
    if (f) exploded.push({ severity: 'error', status: 'failed', blocking: r.blocking, file: f });
  }
  return exploded;
}

function explodeWarnings(d: { warnings?: string[] } | undefined): ConvertedGuardResult[] {
  if (!d || !Array.isArray(d.warnings)) return [];
  const exploded: ConvertedGuardResult[] = [];
  for (const s of d.warnings) {
    const f = eslintFileOf(s);
    if (f) exploded.push({ severity: 'warning', status: 'warning', blocking: false, file: f });
  }
  return exploded;
}

function explodeFindings(d: { findings?: Array<{ file?: string }> } | undefined, r: GuardCheckResultLike): ConvertedGuardResult[] {
  if (!d || !Array.isArray(d.findings)) return [];
  const exploded: ConvertedGuardResult[] = [];
  for (const f of d.findings) {
    if (f && typeof f.file === 'string' && f.file) {
      exploded.push({ severity: r.severity, status: r.status, blocking: r.blocking, file: f.file });
    }
  }
  return exploded;
}
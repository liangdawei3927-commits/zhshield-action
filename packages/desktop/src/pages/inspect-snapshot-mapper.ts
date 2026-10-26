/**
 * 按域落盘快照 → 体检报告视图（**仅问题项**）。
 *
 * 背景：分类页显示的评分来自持久化（`getScore` / `getDomainScore`），重启后仍在；
 * 而页面内存 `report` 只在本次会话扫描后才有。二者不同源 → 出现「有评分却没有详情入口」。
 * 本映射器让页面在挂载时用落盘快照补出详情，使「有分即可看详情」成立。
 *
 * 语义边界（务必记住）：
 * - 快照 `DiagnosticsReport` **只保留问题条目**，通过项不落盘 → 映射结果的
 *   `coverage = 'issues-only'`，UI **不得**据此宣称「通过数 / 通过率」。
 * - 按 `ruleId` 聚合（同一规则的多条违规合并为一条 check），与实时报告
 *   「一规则一 check」同粒度；detail 汇总前 3 条违规，与 `buildDetail` 口径一致。
 * - 快照不存在返回 null（无历史结果 → 不应显示详情入口），
 *   但快照存在且 0 问题 **不是** null —— 那代表「检查过且未发现问题」，要能查看。
 */

import type { DomainReportSnapshot, InspectionReportData } from '../types/electron';

type Check = InspectionReportData['checks'][number];
type SnapshotIssue = DomainReportSnapshot['issues'][number];

const SEVERITY_RANK: Record<SnapshotIssue['severity'], number> = {
  error: 3,
  warning: 2,
  info: 1,
};

/** 归一化严重级 → 报告 check 状态（1:1，info 保留为 info，不冒充「未检测」） */
function statusFor(severity: SnapshotIssue['severity']): Check['status'] {
  switch (severity) {
    case 'error':
      return 'fail';
    case 'warning':
      return 'warn';
    case 'info':
      return 'info';
  }
}

/** 同一规则的多条违规 → 单条 detail（前 3 条 + 总量提示） */
function buildDetail(issues: readonly SnapshotIssue[]): string {
  const lines = issues.slice(0, 3).map((i) => {
    const location = i.line ? `${i.file}:${i.line}` : i.file;
    return `${location} ${i.message}`.trim();
  });
  if (issues.length > 3) lines.push(`… 等 ${issues.length} 条违规`);
  return lines.join('；');
}

/**
 * 将落盘快照映射为体检报告视图。
 *
 * @param snapshot 该域最近一次落盘快照；`null` = 从未落盘 → 返回 `null`
 * @returns 仅问题项的体检报告（`coverage: 'issues-only'`）；无快照返回 `null`
 */
export function toInspectionReportDataFromSnapshot(
  snapshot: DomainReportSnapshot | null,
): InspectionReportData | null {
  if (!snapshot) return null;

  const byRule = new Map<string, SnapshotIssue[]>();
  for (const issue of snapshot.issues) {
    const bucket = byRule.get(issue.ruleId);
    if (bucket) bucket.push(issue);
    else byRule.set(issue.ruleId, [issue]);
  }

  const checks: Check[] = [];
  for (const [ruleId, issues] of byRule) {
    const worst = issues.reduce((a, b) =>
      SEVERITY_RANK[b.severity] > SEVERITY_RANK[a.severity] ? b : a,
    );
    checks.push({
      id: ruleId,
      name: ruleId,
      // P1-7：工具执行失败（toolError）不是代码问题——归「未检测」（attention），
      // 与实时路径 mapStatus 的 error→attention 口径对齐，不进问题计数、不冒充项目缺陷
      status: worst.toolError === true ? 'attention' : statusFor(worst.severity),
      detail: buildDetail(issues),
      ...(worst.category ? { category: worst.category } : {}),
      source: worst.source,
    });
  }

  const failures = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;
  const infos = checks.filter((c) => c.status === 'info').length;

  return {
    // passed 未知（通过项未落盘），置 0 但由 coverage 标注禁止据此展示通过数
    summary: { total: checks.length, passed: 0, warnings: warnings + infos, failures },
    checks,
    metadata: { duration: 0, timestamp: snapshot.generatedAt },
    coverage: 'issues-only',
  };
}

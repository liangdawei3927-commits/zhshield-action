import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DomainReportSnapshot } from '../types/electron';
import { toInspectionReportDataFromSnapshot } from '../pages/inspect-snapshot-mapper';

/**
 * 体检页「有评分即可看详情」——历史落盘快照 → 报告视图。
 *
 * 背景：评分来自持久化（getScore / getDomainScore），重启后仍在；而页面内存 report
 * 只在本次会话扫描后才有。二者不同源，导致「有分数却没有详情入口」。映射器让页面挂载时
 * 用按域快照补出详情。快照**只含问题项**（通过项不落盘），故必须以 coverage='issues-only'
 * 标注，UI 不得据此宣称通过数/通过率。
 */

function snapshot(overrides: Partial<DomainReportSnapshot> = {}): DomainReportSnapshot {
  return {
    generatedAt: '2026-10-23T10:00:00.000Z',
    summary: { total: 3, error: 1, warning: 1, info: 1 },
    issues: [],
    ...overrides,
  };
}

function issue(
  ruleId: string,
  severity: 'error' | 'warning' | 'info',
  message: string,
  line?: number,
): DomainReportSnapshot['issues'][number] {
  return {
    ruleId,
    severity,
    category: 'quality',
    message,
    file: 'src/a.ts',
    ...(line ? { line } : {}),
    autoFixable: false,
    source: 'inspect',
    fingerprint: `${ruleId}:${message}`,
  };
}

describe('toInspectionReportDataFromSnapshot', () => {
  it('无快照返回 null（无历史结果 → 不应出现详情入口）', () => {
    expect(toInspectionReportDataFromSnapshot(null)).toBeNull();
  });

  it('0 问题也是有效结果（检查过且未发现问题 → 必须能查看）', () => {
    const report = toInspectionReportDataFromSnapshot(snapshot({ issues: [] }));
    expect(report).not.toBeNull();
    expect(report!.coverage).toBe('issues-only');
    expect(report!.checks).toHaveLength(0);
    expect(report!.metadata.timestamp).toBe('2026-10-23T10:00:00.000Z');
  });

  it('按 ruleId 聚合，取最严重级别，detail 汇总违规', () => {
    const report = toInspectionReportDataFromSnapshot(
      snapshot({
        issues: [
          issue('layer-boundary', 'error', 'layer violated', 12),
          issue('layer-boundary', 'info', 'minor note', 20),
        ],
      }),
    )!;
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({
      id: 'layer-boundary',
      status: 'fail',
      source: 'inspect',
    });
    expect(report.checks[0].detail).toContain('src/a.ts:12 layer violated');
    expect(report.checks[0].detail).toContain('src/a.ts:20 minor note');
  });

  it('严重级 1:1 映射（error→fail / warning→warn / info→info），info 不冒充未检测', () => {
    const report = toInspectionReportDataFromSnapshot(
      snapshot({
        issues: [
          issue('r-error', 'error', 'e'),
          issue('r-warning', 'warning', 'w'),
          issue('r-info', 'info', 'i'),
        ],
      }),
    )!;
    expect(report.checks.map((c) => c.status)).toEqual(['fail', 'warn', 'info']);
    expect(report.summary).toMatchObject({ total: 3, failures: 1, warnings: 2 });
  });

  it('覆盖率恒为 issues-only（快照不含通过项，不得据此算通过率）', () => {
    const report = toInspectionReportDataFromSnapshot(
      snapshot({ issues: [issue('r', 'warning', 'w')] }),
    )!;
    expect(report.coverage).toBe('issues-only');
    expect(report.summary.passed).toBe(0);
  });
});

describe('体检页挂载 hydrate（结构守卫，防接线被删）', () => {
  const pagesDir = path.resolve(__dirname, '../pages');

  it('inspect-logic 挂载时读回按域快照，且不给实时 report 打补丁', () => {
    const src = fs.readFileSync(path.join(pagesDir, 'inspect-logic.ts'), 'utf-8');
    expect(src).toContain("getDomainReport(projectPath, 'inspect')");
    expect(src).toContain('toInspectionReportDataFromSnapshot');
    // 快照必须独立成 persisted，绝不能塞进 report（否则「扫描中」会显示旧报告、失败态会清空历史）
    expect(src).toContain('persisted');
    expect(src).not.toContain('prev ?? hydrated');
  });

  it('InspectPage 详情判定：实时 > 完整报告 > 快照，扫描中不用旧数据顶替', () => {
    const src = fs.readFileSync(path.join(pagesDir, 'InspectPage.tsx'), 'utf-8');
    expect(src).toContain(
      'const detailReport = report ?? (loading ? null : (savedReport ?? persisted));',
    );
    // 打开页面仍落在主页（不因读回历史结果而自动跳进详情）
    expect(src).toContain('const [showHome, setShowHome] = useState(true);');
    // 实时报告的通过进度条必须保留（快照回退时才隐藏，因为通过项未知）
    expect(src).toContain('<ProgressBar passCount={passCount} total={items.length} />');
  });
});

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

  /**
   * P1-7（实测报告 2026-10-27）：纯 JS 项目没有 tsconfig，dep-cruiser 报 TS5083、
   * ESLint 装不起来报 ERR_MODULE_NOT_FOUND——这是「我们的工具没跑起来」，不是
   * 「你的代码有问题」。快照读回若把 toolError 条目映成 warn 问题项，用户读到的是
   * 虚假的项目缺陷。必须归 attention（未检测），不进问题计数，与实时路径
   * mapStatus 的 error→attention 口径对齐。
   */
  it('toolError 条目归 attention（未检测），不冒充项目问题（P1-7）', () => {
    const toolErrorIssue = {
      ...issue('inspect.scan.official.circular-dependency', 'warning', '工具 dep-cruiser 错误: TS5083'),
      toolError: true as const,
    };
    const report = toInspectionReportDataFromSnapshot(
      snapshot({
        issues: [
          issue('real-rule', 'error', '真实代码问题'),
          toolErrorIssue,
        ],
      }),
    )!;
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId['inspect.scan.official.circular-dependency'].status).toBe('attention');
    expect(byId['real-rule'].status).toBe('fail');
    // 问题计数只含真问题：failures=1（真实问题），warnings=0（工具错误不算）
    expect(report.summary).toMatchObject({ total: 2, failures: 1, warnings: 0 });
    // isIssueStatus 只认 fail/warn/info → 问题列表不含工具错误
    expect(report.checks.filter((c) => c.status === 'warn' || c.status === 'fail')).toHaveLength(1);
  });

  it('混合规则组：同规则下真问题(error)与工具错误并存 → 按真问题计 fail', () => {
    const report = toInspectionReportDataFromSnapshot(
      snapshot({
        issues: [
          { ...issue('mixed-rule', 'warning', '工具失败'), toolError: true as const },
          issue('mixed-rule', 'error', '真实违规'),
        ],
      }),
    )!;
    expect(report.checks[0].status).toBe('fail');
    expect(report.summary.failures).toBe(1);
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

  /**
   * 「打开先落主页」是全站唯一口径（见 nav-items.ts 与 InspectPage 的注释）。
   *
   * 2026-10-25 实测：门禁 / 哨兵 / 备份三页仍是 `useState(false)`。那个 false 写于
   * 「report/events/records 恒为空」的年代 —— 当时落主页是副作用，不是意图；后来数据
   * 改成挂载即从磁盘读回，hasDetail 一进来就为真，同一个 false 立刻变成「点进去直接
   * 是详情页」，与其余七个分类相反。这类「初值随数据源变更而变质」的漂移不会报错、
   * 不会被行为测试抓到（页面各自有快照/空态分支都正常渲染），只能按源码口径锁住。
   */
  it('分类页「打开先落主页」口径统一：showHome 初值一律为 true', () => {
    const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.tsx'));
    const read = (f: string) => fs.readFileSync(path.join(pagesDir, f), 'utf-8');
    const withToggle = files.filter((f) =>
      read(f).includes('const [showHome, setShowHome] = useState('),
    );
    // 初值不是 true 的页面 = 违反了「打开先落主页」
    const offenders = withToggle.filter(
      (f) => !read(f).includes('const [showHome, setShowHome] = useState(true);'),
    );
    expect(offenders).toEqual([]);
    // inspect / security / refactor / guard / sentinel / backup 六个页面显式持有视图状态；
    // 依赖、垃圾、性能、技术债走 useDomainDetailPage 内部的同一初值（下面单独断言）。
    expect(withToggle.length).toBeGreaterThanOrEqual(6);

    const hookSrc = fs.readFileSync(
      path.resolve(__dirname, '../hooks/useDomainDetailEntry.ts'),
      'utf-8',
    );
    expect(hookSrc).toContain('const [showHome, setShowHome] = useState(true);');
  });
});

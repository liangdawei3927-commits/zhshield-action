import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { DomainSnapshotReport } from '../components/business/DomainSnapshotReport';
import { toSnapshotReport, SNAPSHOT_ENTRY_LIMIT } from '../pages/domain-snapshot-logic';

// node 环境下 navigator.language 为 en-US，I18nProvider 会解析成英文；
// 这里固定为简体中文，断言才锚得住中文文案（否则断言随环境语言漂移）。
vi.stubGlobal('navigator', { language: 'zh-Hans' });

/**
 * 「点详情 → 直接看上次结果」的行为守卫。
 *
 * 用户诉求（2026-10-23）：「已经检查过且有分数的页面，点详情就该看到上次的评分详情，
 * 不该进入扫描状态」。因此这里锁三件事：
 * 1) 快照整形忠实：有几分、几条问题，就显示几分、几条，不补造通过项；
 * 2) 渲染出的就是上次结果本身（条目文案、时间、计数）；
 * 3) 重新检查是页面上的显式按钮，而不是打开视图就自动触发。
 */

describe('快照整形（toSnapshotReport）', () => {
  it('归一化诊断：按 summary 取计数，条目按严重级排序', () => {
    const report = toSnapshotReport({
      generatedAt: '2026-10-23T12:00:00.000Z',
      summary: { total: 3, error: 1, warning: 1, info: 1 },
      issues: [
        { ruleId: 'r-info', severity: 'info', message: '提示项', file: '', autoFixable: false, fingerprint: 'f3' },
        { ruleId: 'r-err', severity: 'error', message: '错误项', file: 'a.ts', line: 3, column: 5, autoFixable: true, fingerprint: 'f1' },
        { ruleId: 'r-warn', severity: 'warning', message: '警告项', file: 'b.ts', line: 9, autoFixable: false, fingerprint: 'f2' },
      ],
    });

    expect(report).not.toBeNull();
    expect(report?.shape).toBe('issues');
    expect(report?.generatedAt).toBe('2026-10-23T12:00:00.000Z');
    expect([report?.total, report?.error, report?.warning, report?.info]).toEqual([3, 1, 1, 1]);
    // error → warning → info
    expect(report?.entries.map((e) => e.severity)).toEqual(['error', 'warning', 'info']);
    expect(report?.entries[0]).toMatchObject({
      key: 'f1',
      title: '错误项',
      location: 'a.ts:3:5',
      ruleId: 'r-err',
      autoFixable: true,
    });
  });

  it('summary 缺失时按真实条目数兜底，不写死 0', () => {
    const report = toSnapshotReport({
      issues: [{ ruleId: 'r', severity: 'warning', message: 'm', file: '', autoFixable: false }],
    });
    expect(report?.total).toBe(1);
    expect(report?.warning).toBe(1);
    expect(report?.error).toBe(0);
  });

  it('零问题快照 → 有效报告（满分也要能看），不是 null', () => {
    const report = toSnapshotReport({
      generatedAt: '2026-10-23T01:00:00.000Z',
      summary: { total: 0, error: 0, warning: 0, info: 0 },
      issues: [],
    });
    expect(report).not.toBeNull();
    expect(report?.shape).toBe('empty');
    expect(report?.entries).toEqual([]);
    expect(report?.total).toBe(0);
  });

  it('清单形态（垃圾域 items）也能展示，按提示归集', () => {
    const report = toSnapshotReport({
      timestamp: '2026-10-22T08:00:00.000Z',
      summary: { total: 1, size: 1024, byType: { dist: 1 } },
      items: [{ id: 'g1', type: 'dist', path: 'packages/x/dist', size: 1024, reason: '构建产物' }],
    });
    expect(report?.shape).toBe('items');
    expect(report?.generatedAt).toBe('2026-10-22T08:00:00.000Z');
    expect(report?.entries[0]).toMatchObject({
      key: 'g1',
      severity: 'info',
      title: '构建产物',
      location: 'packages/x/dist',
    });
  });

  it('非对象/损坏输入 → null（视图回退，不渲染假报告）', () => {
    expect(toSnapshotReport(null)).toBeNull();
    expect(toSnapshotReport('oops')).toBeNull();
    expect(toSnapshotReport([])).toBeNull();
  });
});

describe('DomainSnapshotReport 渲染「上次结果」', () => {
  const snapshot = toSnapshotReport({
    generatedAt: '2026-10-23T12:00:00.000Z',
    summary: { total: 2, error: 1, warning: 1, info: 0 },
    issues: [
      {
        ruleId: 'env:node',
        severity: 'error',
        message: '.nvmrc 与 package.json engines.node 声明的 Node 版本不一致',
        file: '',
        autoFixable: false,
        fingerprint: 'f1',
      },
      {
        ruleId: 'core-import',
        severity: 'warning',
        message: '@zh/core 从 src 直接导入',
        file: 'packages/x/a.ts',
        line: 12,
        autoFixable: true,
        fingerprint: 'f2',
      },
    ],
  });

  const render = (rescanning: boolean): string =>
    renderToStaticMarkup(
      <I18nProvider>
        <DomainSnapshotReport
          projectPath="/tmp/proj"
          dimension="dependencies"
          icon={<span />}
          snapshot={snapshot}
          loading={false}
          rescanning={rescanning}
          onRescan={() => undefined}
          onBackHome={() => undefined}
        />
      </I18nProvider>,
    );

  it('渲染上次结果的条目与计数（不是空态）', () => {
    const markup = render(false);
    expect(markup).toContain('最近一次检查结果');
    expect(markup).toContain('env:node');
    expect(markup).toContain('engines.node 声明的 Node 版本不一致');
    expect(markup).toContain('packages/x/a.ts:12');
    expect(markup).toContain('问题总数');
    // 说明这是落盘结果，避免被当成「刚扫完」
    expect(markup).toContain('这是该分类最近一次检查保存下来的结果');
  });

  it('重新检查是显式按钮：默认不进入扫描态，也不会自动开始', () => {
    const idle = render(false);
    expect(idle).toContain('重新检查');
    // 默认不应出现扫描进度条（否则等于打开即扫描）
    expect(idle).not.toContain('zh-progress-indeterminate');
  });

  it('超过上限时告知被截断（不假装是全量）', () => {
    const many = toSnapshotReport({
      summary: { total: SNAPSHOT_ENTRY_LIMIT + 5, error: 0, warning: SNAPSHOT_ENTRY_LIMIT + 5, info: 0 },
      issues: Array.from({ length: SNAPSHOT_ENTRY_LIMIT + 5 }, (_, i) => ({
        ruleId: `r${i}`,
        severity: 'warning',
        message: `问题 ${i}`,
        file: '',
        autoFixable: false,
        fingerprint: `f${i}`,
      })),
    });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <DomainSnapshotReport
          projectPath="/tmp/proj"
          dimension="refactor"
          icon={<span />}
          snapshot={many}
          loading={false}
          rescanning={false}
          onRescan={() => undefined}
          onBackHome={() => undefined}
        />
      </I18nProvider>,
    );
    expect(markup).toContain(`共 ${SNAPSHOT_ENTRY_LIMIT + 5} 条`);
  });
});

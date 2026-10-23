import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { navItems, navScanProgress } from '../components/layout/nav-items';
import { DomainScanProgress } from '../components/business/DomainScanProgress';
import { ReportShell } from '../components/business/ReportShell';
import { TASK_KIND_DEFAULT_LABELS } from '../task-store';
import { I18nProvider } from '../i18n';

/**
 * 扫描进度条契约守卫。
 *
 * 覆盖三处曾经漂移/缺失的地方：
 * 1) 导航分类 → 任务类型的唯一映射（哪些分类有统一进度条、进度归属是谁）；
 * 2) 进度单位契约（任务中心 0..1 → 百分比 0..100，换算只在 DomainScanProgress 一处）；
 * 3) 结果态（ReportShell）也必须有进度槽位 —— 此前只有空态 PageShell 有，
 *    导致「重新扫描」期间页面完全没有进度反馈。
 */

const VALID_TASK_KINDS = Object.keys(TASK_KIND_DEFAULT_LABELS);

describe('导航分类的扫描进度映射', () => {
  it('10 个分类全部登记了进度来源或明确无进度', () => {
    const noProgress = navItems.filter((item) => item.scanProgress === undefined).map((i) => i.id);
    expect(navItems).toHaveLength(10);
    expect(noProgress.sort()).toEqual(['backup', 'sentinel']);
  });

  it('每个分类订阅的任务类型都必须是任务中心真实存在的 kind', () => {
    for (const item of navItems) {
      const source = item.scanProgress;
      if (!source) continue;
      expect(VALID_TASK_KINDS, `${item.id} 指向了不存在的任务类型`).toContain(source.taskKind);
    }
  });

  it('8 个扫描分类各自拥有独立任务类型（不再借用 pipeline）', () => {
    const expected: Record<string, string> = {
      inspect: 'pipeline',
      guard: 'guard',
      security: 'security',
      deps: 'deps',
      garbage: 'garbage',
      performance: 'performance',
      techdebt: 'techdebt',
      refactor: 'refactor',
    };
    for (const [id, kind] of Object.entries(expected)) {
      expect(navScanProgress(id), `${id} 缺少进度映射`).toEqual({ taskKind: kind });
    }
  });

  it('任务类型映射唯一：同一 kind 至多归属一个分类', () => {
    const kinds = navItems.flatMap((item) =>
      item.scanProgress ? [item.scanProgress.taskKind] : [],
    );
    expect(kinds).toHaveLength(new Set(kinds).size);
  });
});

describe('DomainScanProgress 单位契约与显示门禁', () => {
  it('任务中心的 0..1 进度换算成 0..100 百分比', () => {
    const markup = renderToStaticMarkup(
      <DomainScanProgress loading progress={0.42} label="扫描中" />,
    );
    expect(markup).toContain('42%');
  });

  it('越界进度收敛到 0..100', () => {
    expect(renderToStaticMarkup(<DomainScanProgress loading progress={1.5} />)).toContain('100%');
    expect(renderToStaticMarkup(<DomainScanProgress loading progress={-0.2} />)).not.toContain('%');
  });

  it('进度为 0 时退化为不确定态（不显示百分比，但仍有可见的条）', () => {
    const markup = renderToStaticMarkup(<DomainScanProgress loading progress={0} />);
    expect(markup).toContain('zh-progress-indeterminate');
    expect(markup).not.toContain('%');
  });

  it('未运行时不渲染任何进度条', () => {
    expect(renderToStaticMarkup(<DomainScanProgress loading={false} progress={0.42} />)).toBe('');
  });

  it('NaN 进度不渲染（不得把 NaN 打到界面上）', () => {
    const markup = renderToStaticMarkup(<DomainScanProgress loading progress={Number.NaN} />);
    expect(markup).toBe('');
  });
});

describe('结果态（ReportShell）进度槽位', () => {
  function renderReportShell(props: { loading: boolean; progress: number }): string {
    return renderToStaticMarkup(
      <I18nProvider>
        <ReportShell
          projectPath="/tmp/project"
          dimension="quality"
          icon={<span>icon</span>}
          title="体检结果"
          score={<span>score</span>}
          action={<span>action</span>}
          onBackHome={() => {}}
          loading={props.loading}
          progress={props.progress}
        />
      </I18nProvider>,
    );
  }

  it('重新扫描时结果态也渲染进度条', () => {
    expect(renderReportShell({ loading: true, progress: 0.6 })).toContain('60%');
  });

  it('未运行时结果态不出现进度条', () => {
    expect(renderReportShell({ loading: false, progress: 0.6 })).not.toContain('%');
  });
});

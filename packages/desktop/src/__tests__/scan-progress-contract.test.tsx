import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { navItems, navScanProgress } from '../components/layout/nav-items';
import { DomainScanProgress } from '../components/business/DomainScanProgress';
import { ReportShell } from '../components/business/ReportShell';
import { TASK_KIND_DEFAULT_LABELS } from '../task-store';
import { I18nProvider } from '../i18n';
import { BackupEmptyState } from '../pages/backup-empty-state';
import { BackupProgressBar } from '../pages/backup-parts';

/**
 * 扫描进度条契约守卫。
 *
 * 覆盖三处曾经漂移/缺失的地方：
 * 1) 导航分类 → 任务类型的唯一映射（哪些分类有统一进度条、进度归属是谁）；
 * 2) 进度单位契约（任务中心 0..1 → 百分比 0..100，换算只在 DomainScanProgress 一处）；
 * 3) 分类**详情页**（ReportShell，检查结果态）顶部不再渲染进度条 —— 2026-10-26 下线。
 *    分类**主页**（PageShell，空态）按钮上方的进度条是另一回事，仍然保留。
 *    两者极易混淆：误删主页进度条会连带毁掉主页的运行反馈。
 * 4) 单一视觉契约 —— 2026-10-25 把「label 行 + 静态填充」与「整条循环扫动」两种样式
 *    合并成一种（填充段宽度=进度 + 内部光带流动 + 右侧百分比）。合并后最易回退的
 *    是「把整条扫动当成动效复用到确定态」，故单独立断言守住。
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
    // 百分比槽位保留占位符，避免条在 0% → 1% 时因右侧数字出现而整体位移
    expect(markup).toContain('—');
  });

  it('未运行时不渲染任何进度条', () => {
    expect(renderToStaticMarkup(<DomainScanProgress loading={false} progress={0.42} />)).toBe('');
  });

  it('NaN 进度不渲染（不得把 NaN 打到界面上）', () => {
    const markup = renderToStaticMarkup(<DomainScanProgress loading progress={Number.NaN} />);
    expect(markup).toBe('');
  });
});

describe('单一视觉契约（两种进度条样式已合并）', () => {
  it('确定态同时具备「宽度 = 进度」与「内部流动光带」', () => {
    const markup = renderToStaticMarkup(<DomainScanProgress loading progress={0.42} />);
    expect(markup).toContain('width:42%');
    expect(markup).toContain('zh-progress-flow');
  });

  it('确定态不得整条循环扫动（条的位置必须服从进度，不能与百分比脱钩）', () => {
    // 整条扫动是 indeterminate 的符号：它与数字并列时会读作「卡住了还在转」。
    // 这条断言是本次合并最容易回退的地方 —— 一旦有人把 indeterminate 当成动效复用，必红。
    const markup = renderToStaticMarkup(<DomainScanProgress loading progress={0.42} />);
    expect(markup).not.toContain('zh-progress-indeterminate');
  });

  it('任务消息降级为 title，不进可见文字行', () => {
    const markup = renderToStaticMarkup(
      <DomainScanProgress loading progress={0.42} label="正在扫描 src/a.ts" />,
    );
    expect(markup).toContain('title="正在扫描 src/a.ts"');
    expect(markup).not.toContain('>正在扫描 src/a.ts<');
  });

  it('空消息不生成空 title 属性', () => {
    const markup = renderToStaticMarkup(
      <DomainScanProgress loading progress={0.42} label="   " />,
    );
    expect(markup).not.toContain('title=');
  });
});

describe('详情页不再渲染页内进度条（2026-10-26 下线）', () => {
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

  it('结果态即使传入 loading + progress 也不渲染进度条', () => {
    // 反转守卫：此处曾是「重新扫描时结果态也渲染进度条」（含 60%）。
    // 详情页已不要页内进度条，一旦有人把 DomainScanProgress 装回 ReportShell，必红。
    const markup = renderReportShell({ loading: true, progress: 0.6 });
    expect(markup).not.toContain('zh-progress-flow');
    expect(markup).not.toContain('zh-progress-indeterminate');
    expect(markup).not.toContain('60%');
  });

  it('未运行时同样不出现进度条', () => {
    expect(renderReportShell({ loading: false, progress: 0.6 })).not.toContain('%');
  });
});

describe('备份分域进度条（不走任务中心，单位自成一派）', () => {
  const backupProgress = {
    projectId: 'p1',
    backupId: 'b1',
    phase: 'copy',
    percent: 40,
    message: '正在复制文件',
  };

  it('kernel 的 percent（0..100）必须先归一化成 0..1 再进进度条', () => {
    // 回归：此前直接透传 percent，被 DomainScanProgress 再 ×100 ⇒ 40 → 4000 → clamp 100，
    // 备份一开跑进度条就是满条。断言必须出现 40% 且绝不出现 100%。
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BackupEmptyState
          projectPath="/tmp/project"
          isBackingUp
          progress={backupProgress}
          onBackup={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('40%');
    expect(markup).not.toContain('100%');
  });

  it('详情页进度条与主链路同一视觉：宽度=进度 + 内部光带 + 消息降级 title', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BackupProgressBar progress={{ ...backupProgress, percent: 70, message: '正在压缩' }} />
      </I18nProvider>,
    );
    expect(markup).toContain('width:70%');
    expect(markup).toContain('zh-progress-flow');
    expect(markup).toContain('70%');
    expect(markup).toContain('title="正在压缩"');
    expect(markup).not.toContain('>正在压缩<');
  });
});

describe('页内进度条下线的源码级守卫', () => {
  const SRC = path.resolve(__dirname, '..');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf-8');

  it('详情页（ReportShell）不得再把顶部进度条装回来', () => {
    // ⚠️ 只盯详情页。分类**主页**（PageShell）按钮上方的进度条是保留项 ——
    // 10-25 刚把它统一成单一视觉，误删会连带毁掉主页的运行反馈。
    const src = read('components/business/ReportShell.tsx');
    expect(src.includes('DomainScanProgress'), 'ReportShell 又渲染了详情页顶部进度条').toBe(
      false,
    );
  });

  it('分类主页（PageShell）按钮上方的进度条必须还在', () => {
    // 反向守卫：上一轮误把主页进度条一起删了。这里钉住"主页仍有"，
    // 保证后续重构不会再把主页的运行反馈弄丢。
    const src = read('components/business/PageShell.tsx');
    expect(src.includes('DomainScanProgress'), 'PageShell 的主页进度条被误删').toBe(true);
  });

  it('扫描范围自证：两个文件都真实读到了内容', () => {
    for (const rel of [
      'components/business/PageShell.tsx',
      'components/business/ReportShell.tsx',
    ]) {
      expect(read(rel).length, `${rel} 读取为空，守卫形同虚设`).toBeGreaterThan(200);
    }
  });
});

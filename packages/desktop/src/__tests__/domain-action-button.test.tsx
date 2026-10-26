/**
 * 域主操作按钮的渲染行为（用户可见的那一面）。
 *
 * 用户的原话：「这个按钮上面只能显示比如巡检中…、扫描中…、盘点中…、检查中…，
 * 不应该显示其他文字」。这里用静态渲染锁住按钮文本，而不是只锁源码形状。
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { DomainActionButton } from '../components/business/DomainActionButton';
import { ACTION_RUNNING_LABEL_KEY } from '../components/business/domain-action-text';

// 断言的是中文状态下用户看到的字，先把语言固定成 zh-Hans（node 环境无 localStorage，
// I18nProvider 会退回 navigator.language 判定，默认落到 en）
beforeAll(() => {
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

type ButtonProps = Parameters<typeof DomainActionButton>[0];

function render(props: ButtonProps): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DomainActionButton {...props} />
    </I18nProvider>,
  );
}

/** 取按钮纯文本（去掉标签与 svg 结构） */
function buttonText(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

describe('域主操作按钮渲染', () => {
  it('空闲态显示动作文案（一键体检 / 立即扫描 / 开始盘点）', () => {
    expect(buttonText(render({ domain: 'inspect', label: '一键体检' }))).toBe('一键体检');
    expect(buttonText(render({ domain: 'guard', label: '立即扫描' }))).toBe('立即扫描');
    expect(buttonText(render({ domain: 'deps', label: '开始盘点' }))).toBe('开始盘点');
  });

  it('运行中只显示状态词，不出现百分比 / 任务消息 / 通用「加载中」', () => {
    const busy = buttonText(render({ domain: 'inspect', label: '一键体检', loading: true }));
    expect(busy).toContain('巡检中');
    expect(busy).not.toContain('一键体检');
    expect(busy).not.toMatch(/%|·/);
    expect(busy).not.toContain('加载');
  });

  it('十域与三个非域动作都能渲染出状态词（键写错会退化成键名本身）', () => {
    for (const domain of Object.keys(ACTION_RUNNING_LABEL_KEY) as (keyof typeof ACTION_RUNNING_LABEL_KEY)[]) {
      const text = buttonText(render({ domain, label: 'X', loading: true }));
      expect(text.length, `${domain} 没有运行态文案`).toBeGreaterThan(0);
      expect(text, `${domain} 显示了键名而非文案`).not.toContain('page.');
      expect(text, `${domain} 显示了键名而非文案`).not.toContain('common.');
      expect(text, `${domain} 混入进度信息`).not.toMatch(/%|·/);
    }
  });

  it('空态与详情页用的是同一个按钮：同 domain 同 loading 下 DOM 属性一致', () => {
    const a = render({ domain: 'garbage', label: '开始扫描', loading: true });
    const b = render({ domain: 'garbage', label: '重新扫描', loading: true });
    // 只有 label 不同（空闲态文本），运行态文本与按钮属性必须一致
    expect(buttonText(a)).toBe(buttonText(b));
    expect(a).toContain('data-domain="garbage"');
    expect(b).toContain('data-domain="garbage"');
    // 220×56 胶囊主按钮样式（w-[220px] h-14）—— 尺寸不再因页面而异
    for (const html of [a, b]) {
      expect(html).toContain('w-[220px]');
      expect(html).toContain('h-14');
    }
  });

  /**
   * 排队态（2026-10-25）：任务已入队但主进程并发槽被占，还没真正开始。
   *
   * 若照旧显示「体检中…」，用户无法区分"在跑但没进度"与"根本没开始"；
   * 实测排队可达数分钟，且归属页的全局指示器被刻意隐藏，按钮是唯一可见面。
   */
  it('排队中显示「排队中」而不是运行态词', () => {
    const queued = buttonText(
      render({ domain: 'inspect', label: '一键体检', loading: true, queued: true }),
    );
    expect(queued).toContain('排队中');
    expect(queued).not.toContain('巡检中');
    expect(queued).not.toContain('一键体检');
  });

  it('排队态只报状态词：不带排队位置、百分比、任务消息', () => {
    const queued = buttonText(
      render({ domain: 'security', label: '立即扫描', loading: true, queued: true }),
    );
    // 位置归进度条（task.queuedLabel），按钮宽度只有 220px
    expect(queued).not.toMatch(/\d/);
    expect(queued).not.toMatch(/%|·/);
    expect(queued).not.toContain('位');
  });

  it('queued 单独为真也进入 loading 态（按钮不可再点）', () => {
    const html = render({ domain: 'deps', label: '开始盘点', queued: true });
    expect(html).toContain('disabled');
    expect(buttonText(html)).toContain('排队中');
    expect(buttonText(html)).not.toContain('开始盘点');
  });

  /**
   * 忙态一视同仁（2026-10-26 用户原话：不管是首次添加/每日首开/定时/手动触发，
   * 只要在巡检，一键巡检按钮就应同步显示「正在巡检中」）——因此没有 autoActive
   * 之类的来源区分 prop：触发来源只作任务上的诊断元数据，不上按钮。
   */
  it('巡检任务运行中，按钮一律显示「巡检中」（不区分触发来源）', () => {
    const text = buttonText(
      render({ domain: 'inspect', label: '一键体检', loading: true }),
    );
    expect(text).toContain('巡检中');
    expect(text).not.toContain('一键体检');
    expect(text).not.toContain('自动');
  });

  it('排队态显示「排队中」且不带位置数字（位置归进度条）', () => {
    const text = buttonText(
      render({ domain: 'inspect', label: '一键体检', loading: true, queued: true }),
    );
    expect(text).toContain('排队中');
    expect(text).not.toContain('一键体检');
    expect(text).not.toMatch(/\d/);
  });
});

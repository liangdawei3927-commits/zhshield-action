/**
 * 详情页标准外壳（DomainReportShell）契约守卫
 *
 * ## 为什么需要这层守卫
 *
 * 2026-11-03 起九个域的详情页外壳统一为 `DomainReportShell`（原先各页手写
 * `<ReportShell><DomainActionButton …>`，逐字重复十余行）。
 *
 * 既有守卫（domain-stop-wiring / domain-queued-wiring）都是**源码 grep**：
 * 它们断言每个页面源码里出现了 `onCancel={` / `queued={` / `stopping={`。
 * 源码 grep 有个先天盲区：**它只验「字段被写了」，不验「字段被传到了哪」**。
 * 若本组件把 `stopping` 误接到别的 prop 上，或漏传 `queued`，这些 grep 全绿，
 * 而用户的「停止中…」/「排队中…」会静默失效 —— 正是本项目最在意的那类退化。
 *
 * 因此本文件补**行为级**断言：渲染出 DOM，看按钮真的进入了对应状态。
 *
 * ## 断言的口径
 *
 *   · 排队 → 按钮显示「排队中…」且可停（hover 出「停止」）
 *   · 忙态 + onCancel → 按钮不 disabled（disabled 会让「停止」变成装饰）
 *   · stopping → 按钮显示「停止中…」并禁用（防连点二次取消）
 *   · 空闲 → 按钮显示动作文案，不出现「停止」
 *   · 未传 onCancel 的域 → 忙态禁用、只显示状态词（不摆点了没反应的入口）
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { DomainReportShell } from '../components/business/domain-report-shell';

beforeAll(() => {
  // node 环境无 localStorage，I18nProvider 退回 navigator.language；固定成中文
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

function render(props: Partial<Parameters<typeof DomainReportShell>[0]> = {}): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DomainReportShell
        projectPath="/tmp/project"
        domain="inspect"
        title="体检结果"
        actionLabel="一键体检"
        onAction={() => undefined}
        onBackHome={() => undefined}
        {...props}
      />
    </I18nProvider>,
  );
}

function textOf(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** 真实的 disabled **属性**（Tailwind class 里也有 `disabled:` 前缀，不能用 includes 判） */
const hasDisabledAttr = (html: string): boolean => /\sdisabled(?:=|[\s>])/.test(html);

describe('DomainReportShell 把接线正确落到主按钮', () => {
  it('排队态：按钮显示「排队中…」且仍可停', () => {
    const html = render({ loading: true, queued: true, onCancel: () => undefined });
    expect(textOf(html)).toContain('排队中');
    // 排队也是「点了没反应」，必须同样能停
    expect(hasDisabledAttr(html), '排队时按钮被禁用了 ⇒ 用户停不下来').toBe(false);
    expect(html).toContain('data-stoppable="true"');
  });

  it('忙态 + onCancel：按钮不禁用（禁用会让 hover 出的「停止」点不动）', () => {
    const html = render({ loading: true, onCancel: () => undefined });
    expect(hasDisabledAttr(html)).toBe(false);
    expect(html).toContain('data-action-text="stop"');
    expect(html).toContain('data-action-text="running"');
  });

  it('已发出取消：显示「停止中…」并禁用（防连点产生第二次取消）', () => {
    const html = render({ loading: true, onCancel: () => undefined, stopping: true });
    expect(textOf(html)).toContain('停止中');
    expect(hasDisabledAttr(html)).toBe(true);
  });

  it('空闲态：只显示动作文案，不出现「停止」', () => {
    const html = render({ label: undefined, actionLabel: '一键体检' });
    expect(textOf(html)).toContain('一键体检');
    expect(textOf(html)).not.toContain('停止');
  });

  it('未传 onCancel：忙态禁用、只显示状态词（不摆点了没反应的入口）', () => {
    const html = render({ loading: true });
    expect(hasDisabledAttr(html)).toBe(true);
    expect(textOf(html)).not.toContain('停止');
  });

  it('页面特有内容（children / stats）正常落在明细区', () => {
    const html = render({
      children: <div data-testid="detail">明细</div>,
    });
    expect(html).toContain('data-testid="detail"');
  });
});

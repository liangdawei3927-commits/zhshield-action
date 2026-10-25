/**
 * 哨兵监控「主页 / 详情页」停止入口的**行为**守卫（2026-10-26）
 *
 * 用户原话：「为什么哨兵监控里面的主页按钮上面没有停止按钮功能，详情页按钮上面才有暂停功能？」
 *
 * ── 根因（不是停止能力缺失，是两处口径分叉）────────────────────────────
 * 哨兵页同时渲染两个视图：
 *   - 主页/空态 `SentinelEmptyView`（DomainEmptyView → PageShell）
 *   - 详情页   `SentinelReportView`（ReportShell 顶部 action 槽）
 * 两者**各算各的忙态**：
 *   - 详情页 `loading={monitoring || loading}` ⇒ 监控中进入忙态 ⇒ hover 出「停止」；
 *   - 主页   `loading={loading}`               ⇒ **漏了 monitoring** ⇒ 监控中不忙
 *           ⇒ 不出「停止」；点击落到 onAction（切详情 + 幂等重启动）
 *           ⇒ 用户看到的是"点了没反应"，而且**永远停不掉**。
 *
 * 而哨兵是**常驻守护**（`useSentinelMonitoring` 挂载即 `startMonitoring()`），
 * 所以"主页监控中却停不掉"是 100% 必现，不是偶发。
 *
 * ── 为什么旧门禁没抓住 ──────────────────────────────────────────────
 * `daemon-pause-wiring.test.ts` 只数源码里 `onCancel={` 出现几次（形状检查），
 * 主页漏了 monitoring 照样 ≥2 ⇒ 一直绿。本测试锁**渲染出来的 DOM**：
 * 按钮到底有没有进入 stoppable 态（data-stoppable / data-action-text="stop" / 未禁用）。
 *
 * ── 修法：忙态判定收成一处 ─────────────────────────────────────────
 * `deriveSentinelActionState()`（sentinel-logic.ts）是唯一判定源，
 * 页面只调一次，主页与详情页都从它取值 ⇒ 口径不再分叉，也没法再各修各的。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, useT } from '../i18n';
import { deriveSentinelActionState, type SentinelActionState } from '../pages/sentinel-logic';
import { SentinelPage, SentinelReportView } from '../pages/SentinelPage';

// ── 哨兵运行状态由测试注入（静态渲染不跑 effect，monitoring 无法自然变 true）──
const injected = vi.hoisted(() => ({
  current: { monitoring: false, loading: false, stopping: false },
}));

vi.mock('../pages/sentinel-logic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/sentinel-logic')>();
  return {
    ...actual,
    useSentinelPage: () => ({
      events: [],
      sorted: [],
      activeCount: 0,
      highCount: 0,
      criticalCount: 0,
      falsePositiveCount: 0,
      loading: injected.current.loading,
      monitoring: injected.current.monitoring,
      stopping: injected.current.stopping,
      refreshEvents: () => undefined,
      startMonitoring: async () => undefined,
      stopMonitoring: async () => undefined,
    }),
  };
});

// 只替换 useNotification：避免把 @zh/kernel 的通知服务整包拉进静态渲染
vi.mock('../contexts/NotificationContext', () => ({
  useNotification: () => ({ notify: () => undefined }),
}));

const SRC = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

beforeAll(() => {
  // node 环境无 localStorage，I18nProvider 退回 navigator.language；固定成中文
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

/** 渲染真实哨兵页（主页分支：showHome 初值 true） */
function renderHomePage(): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SentinelPage projectPath="/tmp/sentinel-demo" />
    </I18nProvider>,
  );
}

/** 渲染详情页视图（主页→详情要点击，静态渲染点不了，只能直接渲染视图） */
function DetailHarness({ action }: { action: SentinelActionState }) {
  const t = useT();
  return (
    <SentinelReportView
      events={[]}
      sorted={[]}
      activeCount={0}
      highCount={0}
      criticalCount={0}
      action={action}
      onRefresh={() => undefined}
      onStopMonitoring={() => undefined}
      onBackHome={() => undefined}
      projectPath="/tmp/sentinel-demo"
      t={t}
    />
  );
}

function renderDetailView(action: SentinelActionState): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DetailHarness action={action} />
    </I18nProvider>,
  );
}

/** 取按钮纯文本（去掉标签与 svg 结构） */
function textOf(html: string): string {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * 只取**域主按钮**那一颗（DomainActionButton 落在 <button data-domain="…">）。
 *
 * 不能取「第一个 <button>」：详情页里返回主页按钮排在前面，取错了断言会落在
 * 无关控件上，测出来的绿是假的。
 */
function actionButtonHtml(html: string): string {
  const m = html.match(/<button[^>]*data-domain="[^"]*"[\s\S]*?<\/button>/);
  return m ? m[0] : '';
}

/** 域主按钮的纯文本 */
function actionButtonText(html: string): string {
  return textOf(actionButtonHtml(html));
}

/** 真实的 disabled **属性**（Tailwind class 里也有 `disabled:` 前缀，不能用 includes 判） */
const hasDisabledAttr = (html: string): boolean => /\sdisabled(?:=|[\s>])/.test(html);

describe('哨兵：忙态判定是唯一口径（主页与详情页同源）', () => {
  it('监控中 ⇒ 忙态 + 可停 + 归属 sentinelMonitor', () => {
    expect(deriveSentinelActionState({ monitoring: true, loading: false, stopping: false })).toEqual({
      busy: true,
      domain: 'sentinelMonitor',
      cancellable: true,
      stopping: false,
    });
  });

  it('未监控且空闲 ⇒ 不忙、不可停', () => {
    expect(deriveSentinelActionState({ monitoring: false, loading: false, stopping: false })).toEqual({
      busy: false,
      domain: 'sentinel',
      cancellable: false,
      stopping: false,
    });
  });

  it('未监控但正在拉事件 ⇒ 忙但**不可停**（没有可取消的执行器，不摆假入口）', () => {
    expect(deriveSentinelActionState({ monitoring: false, loading: true, stopping: false })).toEqual({
      busy: true,
      domain: 'sentinel',
      cancellable: false,
      stopping: false,
    });
  });

  it('停止中 ⇒ 透传 stopping（按钮显示「停止中…」并禁用，防连点）', () => {
    expect(deriveSentinelActionState({ monitoring: true, loading: false, stopping: true })).toEqual({
      busy: true,
      domain: 'sentinelMonitor',
      cancellable: true,
      stopping: true,
    });
  });
});

describe('哨兵主页（空态）：监控中必须能停', () => {
  it('监控中：主按钮自己就是停止入口（hover 出「停止」、未禁用、整页只有一颗按钮）', () => {
    injected.current = { monitoring: true, loading: false, stopping: false };
    const html = renderHomePage();

    // 真阳性自证：断言落在**主按钮**上，不是页面上别的按钮
    expect((html.match(/<button/g) ?? []).length, '主页出现了第二颗按钮').toBe(1);
    const btn = actionButtonHtml(html);
    expect(btn, '没找到域主按钮（data-domain）').not.toBe('');
    expect(btn, '监控中主页按钮没进入可停态 ⇒ 停不掉').toContain('data-stoppable="true"');
    expect(btn, '监控中主页按钮没有 hover 出「停止」').toContain('data-action-text="stop"');
    expect(btn).toContain('data-action-text="running"');
    expect(hasDisabledAttr(btn), '忙态按钮被禁用 ⇒ hover 出的停止点不动').toBe(false);
    expect(actionButtonText(html)).toContain('监控中');
    expect(actionButtonText(html)).toContain('停止');
  });

  it('未监控：主按钮回到空闲态，不出现「停止」', () => {
    injected.current = { monitoring: false, loading: false, stopping: false };
    const html = renderHomePage();

    const btn = actionButtonHtml(html);
    expect(btn).not.toContain('data-stoppable');
    expect(btn).not.toContain('data-action-text="stop"');
    expect(hasDisabledAttr(btn)).toBe(false);
    expect(actionButtonText(html)).toBe('启动监控');
  });

  it('停止中：显示「停止中」并禁用，不再挂「停止」诱导连点', () => {
    injected.current = { monitoring: true, loading: false, stopping: true };
    const html = renderHomePage();

    const btn = actionButtonHtml(html);
    expect(actionButtonText(html)).toBe('停止中');
    expect(hasDisabledAttr(btn)).toBe(true);
    expect(btn).not.toContain('data-action-text="stop"');
  });
});

describe('哨兵详情页：与主页对称（同一个判定源）', () => {
  it('监控中：详情页按钮同样可停', () => {
    const html = renderDetailView(
      deriveSentinelActionState({ monitoring: true, loading: false, stopping: false }),
    );
    const btn = actionButtonHtml(html);
    expect(btn).toContain('data-stoppable="true"');
    expect(btn).toContain('data-action-text="stop"');
    expect(hasDisabledAttr(btn)).toBe(false);
    expect(actionButtonText(html)).toContain('停止');
  });

  it('未监控：详情页按钮回到空闲态（此时是可点的一次性刷新）', () => {
    const html = renderDetailView(
      deriveSentinelActionState({ monitoring: false, loading: false, stopping: false }),
    );
    const btn = actionButtonHtml(html);
    expect(btn).not.toContain('data-stoppable');
    expect(btn).not.toContain('data-action-text="stop"');
    expect(hasDisabledAttr(btn)).toBe(false);
    expect(actionButtonText(html)).toBe('刷新');
  });

  it('主页与详情页在同一状态下渲染出的停止能力一致（对称性）', () => {
    injected.current = { monitoring: true, loading: false, stopping: false };
    const home = renderHomePage();
    const detail = renderDetailView(
      deriveSentinelActionState({ monitoring: true, loading: false, stopping: false }),
    );
    for (const html of [home, detail]) {
      const btn = actionButtonHtml(html);
      expect(btn).toContain('data-stoppable="true"');
      expect(btn).toContain('data-action-text="stop"');
      expect(hasDisabledAttr(btn)).toBe(false);
    }
  });
});

describe('单一来源：页面不许再各算各的忙态', () => {
  it('SentinelPage 只调一次 deriveSentinelActionState（两视图共用同一结果）', () => {
    const src = read('pages/SentinelPage.tsx');
    const calls = src.match(/deriveSentinelActionState\(/g) ?? [];
    // 1 = 页面里唯一的调用点（函数本身的定义/导入不算）
    expect(calls.length, '忙态判定出现了多个调用点 ⇒ 两视图可能又分叉').toBe(1);
  });

  it('两个视图都不再自己拼忙态（不得出现旧的漏 monitoring 写法）', () => {
    const src = read('pages/SentinelPage.tsx');
    // 旧 bug 的两个特征写法：主页漏 monitoring / 详情页就地拼 `monitoring || loading`
    expect(src, '主页又写回了 loading={props.loading}（漏 monitoring）').not.toMatch(
      /loading=\{props\.loading\}/,
    );
    expect(src, '详情页又就地拼了 monitoring || loading（口径分叉）').not.toMatch(
      /loading=\{monitoring \|\| loading\}/,
    );
  });

  it('两个视图都从 action 取忙态（不接受裸 loading/stopping 自行判断）', () => {
    const src = read('pages/SentinelPage.tsx');
    expect(src).toContain('loading={action.busy}');
    expect(src).toContain('onCancel={action.cancellable');
    expect(src).toContain('stopping={action.stopping}');
  });
});

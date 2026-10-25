/**
 * 主按钮「同一颗按钮停止」守卫（2026-10-25 修订）
 *
 * 用户原话：「不是让另外再添加一个独立的停止按钮出来，我的意思是鼠标移到原来的一键
 * 体检主按钮上，会显示停止两个字出来点击后停止，意思公用一个按钮」。
 *
 * 因此契约是：
 * 1) 忙态主按钮**自己**就是停止入口：hover 显示「停止」，点下去触发取消；
 * 2) 不许出现第二个停止按钮 —— 组件文件、DOM 节点、`data-action="stop"` 一个都不留；
 * 3) 忙态可点击 ⇒ **不能 disabled**。这是最容易回归的一条：把 `loading` 传回
 *    PrimaryButton 就会被它内部转成 disabled，hover 出了「停止」也点不动；
 * 4) 已发出取消后显示「停止中」并禁用，防连点产生第二次取消；
 * 5) 8 个域的详情页仍必须传 onCancel / stopping（页面接线不变，只是落点从旁挂按钮
 *    变成主按钮自身）。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { DomainActionButton } from '../components/business/DomainActionButton';

const SRC = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

/** 截取某个 JSX 元素块：从起始标签到它自己的闭合行（`/>`） */
function jsxBlock(src: string, marker: string): string {
  const idx = src.indexOf(marker);
  if (idx < 0) return '';
  const lines = src.slice(idx).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (out.length > 1 && /^\s*\/>/.test(line)) break;
    if (out.length > 400) break;
  }
  return out.join('\n');
}

beforeAll(() => {
  // node 环境无 localStorage，I18nProvider 退回 navigator.language；固定成中文
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

function render(props: Parameters<typeof DomainActionButton>[0]): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <DomainActionButton {...props} />
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

describe('停止入口与主按钮是同一颗（不许第二个按钮）', () => {
  it('DomainStopButton 已彻底删除：文件不存在，源码零引用', () => {
    expect(existsSync(resolve(SRC, 'components/business/DomainStopButton.tsx'))).toBe(false);
    const files: string[] = [];
    for (const dir of ['pages', 'components/business', 'components/ui']) {
      for (const name of readdirSync(resolve(SRC, dir))) {
        if (name.endsWith('.tsx') || name.endsWith('.ts')) files.push(resolve(SRC, dir, name));
      }
    }
    expect(files.length).toBeGreaterThan(50); // 扫描范围自证
    const offenders = files.filter((f) =>
      /DomainStopButton|data-action="stop"/.test(readFileSync(f, 'utf-8')),
    );
    expect(offenders.map((f) => f.replace(SRC, ''))).toEqual([]);
  });

  it('忙态 + onCancel：整页只有一颗 button，含「停止」与状态词两层，且未禁用', () => {
    const html = render({
      domain: 'inspect',
      label: '一键体检',
      loading: true,
      onCancel: () => undefined,
    });
    expect((html.match(/<button/g) ?? []).length).toBe(1);
    // 禁用会直接让「hover 出停止」变成装饰：这是本次的核心契约
    expect(hasDisabledAttr(html), '忙态按钮被禁用了，hover 出的停止点不动').toBe(false);
    expect(html).toContain('data-action-text="stop"');
    expect(html).toContain('data-action-text="running"');
    // 两层都渲染，由 CSS 决定显示哪一个（静态渲染测不到 hover）
    expect(html).toContain('group-hover:hidden');
    expect(html).toContain('group-hover:inline');
    expect(html).toContain('data-stoppable="true"');
    expect(textOf(html)).toContain('体检中');
    expect(textOf(html)).toContain('停止');
  });

  it('排队态同样可以停（排队也是"点了没反应"）', () => {
    const html = render({
      domain: 'deps',
      label: '开始盘点',
      queued: true,
      onCancel: () => undefined,
    });
    expect(hasDisabledAttr(html)).toBe(false);
    expect(textOf(html)).toContain('排队中');
    expect(textOf(html)).toContain('停止');
  });

  it('已发出取消：显示「停止中」并禁用，防连点', () => {
    const html = render({
      domain: 'inspect',
      label: '一键体检',
      loading: true,
      onCancel: () => undefined,
      stopping: true,
    });
    expect(textOf(html)).toContain('停止中');
    expect(hasDisabledAttr(html)).toBe(true);
    // 停止中不再挂 hover 切换层（避免显示「停止」诱导再点一次）
    expect(html).not.toContain('data-action-text="stop"');
  });

  it('空闲态不出现「停止」：主按钮仍只显示动作文案', () => {
    const html = render({ domain: 'guard', label: '立即扫描', onCancel: () => undefined });
    expect(textOf(html)).toBe('立即扫描');
    expect(hasDisabledAttr(html)).toBe(false);
  });

  it('没有 onCancel 的域维持原样：忙态禁用、只显示状态词', () => {
    const html = render({ domain: 'sentinel', label: '立即刷新', loading: true });
    expect(hasDisabledAttr(html)).toBe(true);
    expect(textOf(html)).not.toContain('停止');
  });

  it('点击走 onCancel 而不是重跑（源码调用边）', () => {
    const block = jsxBlock(read('components/business/DomainActionButton.tsx'), '<PrimaryButton');
    expect(block).toMatch(/onCancel/);
  });
});

describe('详情页顶部：主按钮必须能停止（接线不变）', () => {
  /** 走任务中心（useTaskRun）的 8 个域详情页 —— 这才是可取消的域 */
  const HEADER: [file: string, marker: string][] = [
    ['pages/InspectPage.tsx', '<DomainActionButton'],
    ['pages/GuardPage.tsx', '<DomainActionButton'],
    ['pages/security-report-parts.tsx', '<DomainActionButton'],
    ['pages/GarbagePage.tsx', '<DomainActionButton'],
    ['pages/RefactorPage.tsx', '<DomainActionButton'],
    ['pages/PerformancePage.tsx', '<DomainActionButton'],
    ['pages/DependencyPage.tsx', '<DomainActionButton'],
    ['pages/TechDebtPage.tsx', '<DomainActionButton'],
  ];

  for (const [file, marker] of HEADER) {
    it(`${file} 给 DomainActionButton 传了 onCancel`, () => {
      const block = jsxBlock(read(file), marker);
      expect(block, `${file} 里找不到 ${marker}`).not.toBe('');
      expect(block, `${file} 的主按钮没有 onCancel ⇒ 该域停不下来`).toMatch(/onCancel=\{/);
      expect(block, `${file} 没传 stopping（点了停止不会显示停止中）`).toMatch(/stopping=\{/);
    });
  }
});

describe('onCancel 透传链路', () => {
  it('PageShell 把 onCancel 透传给主按钮', () => {
    const block = jsxBlock(read('components/business/PageShell.tsx'), '<DomainActionButton');
    expect(block).toMatch(/onCancel=\{onCancel\}/);
    expect(block).toMatch(/stopping=\{stopping\}/);
  });

  it('DomainEmptyView 把 onCancel 透传给 PageShell', () => {
    expect(read('components/business/DomainEmptyView.tsx')).toMatch(/onCancel=\{props\.onCancel\}/);
  });

  it('PipelineTaskEmptyState（依赖/技术债空态）自订阅取消，不靠页面透传', () => {
    const src = read('components/business/PipelineTaskEmptyState.tsx');
    expect(src).toMatch(/const\s*\{[^}]*cancel[^}]*\}\s*=\s*useTaskRun\(/);
    expect(src).toMatch(/onCancel=\{cancel\}/);
  });
});

describe('取消不会被当成失败：各域 catch 必须识别取消', () => {
  const LOGIC: string[] = [
    'pages/inspect-logic.ts',
    'pages/guard-logic.ts',
    'pages/security-logic.ts',
    'pages/garbage-logic.ts',
    'pages/refactor-logic.ts',
    'pages/performance-logic.ts',
    'pages/dependency-logic.ts',
    'pages/tech-debt-logic.ts',
  ];

  for (const file of LOGIC) {
    it(`${file} 用 isCancelledError（或共用骨架）挡掉取消产生的伪失败`, () => {
      const src = read(file);
      // security / performance 的 handleScan 走共用骨架 useRunWithReport，
      // 判据落在那里（它已识别取消），不在各自文件里重复写一遍。
      expect(
        src.includes('isCancelledError') || src.includes('useRunWithReport'),
        `${file} 没识别取消：点「停止」会落成失败页`,
      ).toBe(true);
    });
  }
});

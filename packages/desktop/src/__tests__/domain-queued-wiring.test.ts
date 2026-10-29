import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 排队态接线守卫（2026-10-25）。
 *
 * 光有 DomainActionButton 的 queued 能力不够 —— 任何一个域漏传，那个域的按钮
 * 在排队时就会继续显示「扫描中…」，用户读作"卡住了"。这类漏传编译不报错
 * （prop 可选），只能靠结构断言兜住。
 */

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

/** 截取某个 JSX 元素块：从起始标签到它自己的闭合行（`/>`），不越界到下一个元素 */
function jsxBlock(src: string, marker: string): string {
  const idx = src.indexOf(marker);
  if (idx < 0) return '';
  const lines = src.slice(idx).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    if (out.length > 1 && /^\s*\/>/.test(line)) break;
    if (out.length > 400) break; // 防御：结构异常时不要无限吞
  }
  return out.join('\n');
}

const EMPTY_VIEWS: [file: string, marker: string][] = [
  // InspectPage 的空态视图（InspectEmptyView）拆到 inspect-views.tsx，DomainEmptyView 接线随迁
  ['pages/inspect-views.tsx', '<DomainEmptyView'],
  ['pages/GuardPage.tsx', '<DomainEmptyView'],
  ['pages/security-empty-state.tsx', '<DomainEmptyView'],
  ['pages/garbage-empty-state.tsx', '<DomainEmptyView'],
  ['pages/refactor-empty-state.tsx', '<DomainEmptyView'],
  ['pages/PerformancePage.tsx', '<DomainEmptyView'],
];

const HEADER_BUTTONS: [file: string, marker: string][] = [
  ['pages/InspectPage.tsx', '<DomainActionButton'],
  ['pages/GuardPage.tsx', '<DomainActionButton'],
  ['pages/security-report-parts.tsx', '<DomainActionButton'],
  ['pages/GarbagePage.tsx', '<DomainActionButton'],
  ['pages/RefactorPage.tsx', '<DomainActionButton'],
  ['pages/PerformancePage.tsx', '<DomainActionButton'],
  ['pages/DependencyPage.tsx', '<DomainActionButton'],
  ['pages/TechDebtPage.tsx', '<DomainActionButton'],
];

describe('空态（健康环下面的大按钮）必须接排队态', () => {
  for (const [file, marker] of EMPTY_VIEWS) {
    it(`${file} 把 queued 传给 DomainEmptyView`, () => {
      const block = jsxBlock(read(file), marker);
      expect(block, `${file} 里找不到 ${marker}`).not.toBe('');
      // 两种合规写法：逐行写 queued={...}，或整块交付给共享尾巴 scanRunProps(props)。
      // 后者的等价性由下面「scanRunProps 仍带 queued」用例自证 —— 否则把 queued 从
      // 共享尾巴里删掉，这里会继续绿而排队文案已经丢了。
      expect(block).toMatch(/queued=\{|\{\.\.\.scanRunProps\(/);
    });
  }

  it('scanRunProps 仍带 queued（共享尾巴与逐行写法等价）', async () => {
    const { scanRunProps } = await import('../components/business/ScanEmptyState');
    const out = scanRunProps({ loading: true, progress: 0.3, queued: true, queuePosition: 2 });
    expect(out.queued).toBe(true);
    expect(out.queuePosition).toBe(2);
    expect(out.loading).toBe(true);
    expect(out.progress).toBe(0.3);
  });

  it('依赖 / 技术债的空态由 PipelineTaskEmptyState 自订阅（不靠页面透传）', () => {
    const src = read('components/business/PipelineTaskEmptyState.tsx');
    expect(src).toMatch(/const\s*\{[^}]*queued[^}]*\}\s*=\s*useTaskRun\(/);
    expect(src).toMatch(/queued=\{queued\}/);
  });
});

describe('详情页顶部按钮必须接排队态', () => {
  for (const [file, marker] of HEADER_BUTTONS) {
    it(`${file} 的 DomainActionButton 收到 queued`, () => {
      const block = jsxBlock(read(file), marker);
      expect(block, `${file} 里找不到 ${marker}`).not.toBe('');
      expect(block).toMatch(/queued=\{/);
    });
  }
});

describe('PageShell 把排队信息同时给按钮和进度条', () => {
  const src = read('components/business/PageShell.tsx');

  it('按钮拿 queued，进度条拿排队位置文案', () => {
    expect(src).toMatch(/queued=\{queued\}/);
    expect(src).toMatch(/task\.queuedLabel/);
    // 排队时按钮也要锁住（不可重复点击）
    expect(src).toMatch(/loading=\{loading \|\| queued\}/);
  });
});

describe('后台自动检查必须声明本页 taskKind（用于"今天已跑过"去重）', () => {
  const cases: [file: string, kind: string][] = [
    ['pages/inspect-logic.ts', "'pipeline'"],
    ['pages/refactor-logic.ts', "'refactor'"],
  ];

  for (const [file, kind] of cases) {
    it(`${file} 调用 useDailyAutoCheck 时传了 ${kind}`, () => {
      const line = read(file)
        .split('\n')
        .find((l) => l.includes('useDailyAutoCheck('));
      expect(line).toBeTruthy();
      expect(line).toContain(kind);
    });
  }
});

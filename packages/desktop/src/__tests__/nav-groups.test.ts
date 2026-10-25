/**
 * 导航分组守卫（2026-10-24 两段式改造）。
 *
 * 锁四件事：
 * 1) **同组必须连续**：分组切成 2 段（按需检查 8 / 常驻守护 2）。把哨兵挪回扫描项
 *    中间会让 `onDemand` 被切成两段 ⇒ 段数变 3，这条就会红 —— 混排不能再回来；
 * 2) **段内顺序不重排**：segments 展开后必须严格等于 navItems（分段只是渲染，不能改顺序）；
 * 3) **分组与扫描进度一致**：按需检查段每项都有独立任务源，常驻守护段都没有
 *    （哨兵长驻监听 / 备份自有进度总线，本就没有"扫一次"的语义）；
 * 4) **首屏第一动作仍是可发起检查的分类**：首位必须是 inspect。
 *
 * 另有一条源码结构断言：TopNav 平铺渲染全部导航项，且**不得**再出现分组竖线
 * （2026-10-25 需求：10 个分类按钮等距平铺，竖线占用宽度会让末两项间距与其他不一致）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  NAV_GROUP_ORDER,
  navGroupSegments,
  navItems,
  navScanProgress,
  type NavGroup,
} from '../components/layout/nav-items';

const EXPECTED_GROUPS: Record<NavGroup, string[]> = {
  onDemand: [
    'inspect',
    'guard',
    'security',
    'deps',
    'garbage',
    'performance',
    'techdebt',
    'refactor',
  ],
  daemon: ['sentinel', 'backup'],
};

describe('导航分组', () => {
  it('切成两段：按需检查在前、常驻守护在后', () => {
    const segments = navGroupSegments();
    expect(segments.map((s) => s.group)).toEqual([...NAV_GROUP_ORDER]);
    expect(segments).toHaveLength(2);
  });

  it('段内 id 与预期分组一致，且顺序不被分段重排', () => {
    const segments = navGroupSegments();
    for (const segment of segments) {
      expect(segment.items.map((i) => i.id), segment.group).toEqual(
        EXPECTED_GROUPS[segment.group],
      );
    }
    // 分段只是渲染：展开回来必须逐项等于原数组（不增不减不换位）
    expect(segments.flatMap((s) => s.items)).toEqual(navItems);
  });

  it('每个分类都显式声明了分组（必填，不允许漏字段后混进按需检查段）', () => {
    for (const item of navItems) {
      expect(['onDemand', 'daemon'], `${item.id} 未声明分组`).toContain(item.group);
    }
  });

  it('按需检查段每项都有独立扫描任务源；常驻守护段都没有', () => {
    for (const segment of navGroupSegments()) {
      for (const item of segment.items) {
        if (segment.group === 'onDemand') {
          expect(navScanProgress(item.id), `${item.id} 缺少进度映射`).toBeDefined();
        } else {
          expect(navScanProgress(item.id), `${item.id} 不该有统一扫描进度`).toBeUndefined();
        }
      }
    }
  });

  it('首位仍是可发起检查的分类（首屏第一动作是体检，不是开启监控）', () => {
    const first = navGroupSegments()[0]!.items[0]!;
    expect(first.id).toBe('inspect');
    expect(first.group).toBe('onDemand');
  });
});

describe('TopNav 平铺渲染（防回归）', () => {
  it('CategoryNav 平铺 navItems，且分组竖线彻底删除', () => {
    const src = readFileSync(
      new URL('../components/layout/TopNav.tsx', import.meta.url),
      'utf-8',
    );
    // 断言**调用边**（CategoryNav 函数体内），而不是组件定义仍在文件里：
    // 定义存在、调用被删时，只看 data-testid 的断言照样绿（负向自证抓到过一次）
    const body = src.slice(src.indexOf('function CategoryNav'), src.indexOf('export function TopNav'));
    // 十项平铺：直接 map navItems（顺序仍由 nav-items 的声明锁定）
    expect(body).toMatch(/navItems\.map\(/);
    expect(body).not.toMatch(/navGroupSegments\(\)/);
    // 竖线必须彻底删除：组件定义、调用边、data-testid 一个都不许留。
    // 只删调用会留下「定义存在但没人用」的死代码，下次有人顺手接回去又变回不统一。
    expect(src).not.toMatch(/GroupDivider|nav-group-divider/);
    // 平铺时不许漏项：导航项总数锁死为 10（8 按需 + 哨兵 + 备份）
    expect(navItems).toHaveLength(10);
  });
});

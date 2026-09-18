import { describe, expect, it } from 'vitest';
import { serializePipelineReport } from '../../electron/pipeline-protocol';
import { navItems } from '../components/layout/nav-items';

/**
 * 顶部导航归位守卫（T9/T11）。
 *
 * 旧测试断言的是一个写死在测试文件里的页面名数组 —— 断言的是它自己，
 * 导航怎么改都不会红。这里改为直接断言真实导航配置（components/layout/nav-items.ts）。
 */
describe('顶部导航归位', () => {
  it('首位是项目体检（inspect）、末位是报告中心（reports）', () => {
    expect(navItems[0]?.id).toBe('inspect');
    expect(navItems.at(-1)?.id).toBe('reports');
  });

  it('不再有 dashboard 项：该页与「8 域串行全检」通道已删除', () => {
    expect(navItems.map((i) => i.id)).not.toContain('dashboard');
    expect(navItems).toHaveLength(10);
  });

  it('id 唯一，且文案一律走 i18n key（无硬编码 label，否则非中文环境会露中文）', () => {
    const ids = navItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of navItems) {
      expect(item.labelKey).toBe(`nav.${item.id}`);
      expect(item.label).toBeUndefined();
    }
  });
});

describe('pipeline 序列化', () => {
  it('keeps pipeline serialization available for pipeline IPC', () => {
    const report = serializePipelineReport({
      timestamp: new Date('2026-07-31T12:00:00.000Z'),
      passed: true,
      stage: 'complete',
      guard: null,
      inspect: null,
      refactor: null,
    }) as { timestamp: string; passed: boolean };

    expect(report.timestamp).toBe('2026-07-31T12:00:00.000Z');
    expect(report.passed).toBe(true);
  });
});

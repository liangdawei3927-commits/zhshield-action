/**
 * 「趋势分析」区块的渲染守卫。
 *
 * 锁四件事：
 * 1) 默认按日聚合，期末分取窗口内最后一次；
 * 2) 期内变化与较上期变化是两列、两个数，不合并；
 * 3) 结论条把扫描次数与总变化如实报出来；
 * 4) 任何情况下都不出现 NaN / undefined —— 报告里出现 NaN 比没有报告更糟。
 *
 * 另有一组**缺口标注的双向自证**（第 8、9 条）：
 * 稀疏数据必须出现断档文案，密集数据必须不出现。
 * 只测「密集数据能渲染」会让缺口逻辑永远不被执行 —— 那是假绿。
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { ReportWindowSection } from '../pages/report-window-parts';
import type { HealthScoreData } from '../types/electron';

// node 环境 navigator.language 为 en-US，固定中文，断言才锚得住文案
vi.stubGlobal('navigator', { language: 'zh-Hans' });

function score(timestamp: string, value: number, dims: Array<[string, number]>): HealthScoreData {
  return {
    score: value,
    timestamp,
    summary: 'ok',
    dimensions: dims.map(([name, s]) => ({ name, score: s, weight: 0.1 })),
  } as HealthScoreData;
}

/** 仿真外层项目的真实历史：10-23 三次、10-24 一次 */
const HISTORY: HealthScoreData[] = [
  score('2026-10-23T03:22:08.000Z', 89.7, [
    ['quality', 89.7],
    ['refactor', 60],
  ]),
  score('2026-10-23T06:32:21.000Z', 90.2, [
    ['quality', 92],
    ['refactor', 58.9],
  ]),
  score('2026-10-23T15:57:56.000Z', 86.3, [
    ['quality', 86.3],
    ['refactor', 58.9],
  ]),
  // 本地 2026-10-24 00:16（GMT+8）= UTC 2026-10-23T16:16Z
  // 注意不能写成 2026-10-24T16:16Z —— 那在本地已是 10-25，会落进下一个窗口
  score('2026-10-23T16:16:19.000Z', 90.3, [
    ['quality', 90.3],
    ['refactor', 58.9],
  ]),
];

function render(data: HealthScoreData[]): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ReportWindowSection data={data} />
    </I18nProvider>,
  );
}

/** 本地时间构造：窗口归属按本地时区，用 ISO 字面量会让测试依赖测试机时区 */
function localIso(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

/** 稀疏数据：10-20 与 10-24 之间空了 3 天，用来触发缺口分支 */
const SPARSE: HealthScoreData[] = [
  score(localIso(2026, 10, 20, 23), 88.2, [['quality', 88.2]]),
  score(localIso(2026, 10, 24, 0), 90.3, [['quality', 90.3]]),
];

describe('ReportWindowSection', () => {
  it('默认按日聚合：两个窗口，期末分取各窗口最后一次', () => {
    const html = render(HISTORY);
    expect(html).toContain('趋势分析');
    expect(html).toContain('2026-10-23');
    expect(html).toContain('2026-10-24');
    // 10-23 期末 86.3、10-24 期末 90.3
    expect(html).toContain('86.3');
    expect(html).toContain('90.3');
  });

  it('期内变化与较上期变化是两列两个数', () => {
    const html = render(HISTORY);
    // 10-23 期内：89.7 → 86.3 = -3.4
    expect(html).toContain('-3.4');
    // 10-24 较上期：90.3 - 86.3 = +4
    expect(html).toContain('+4');
    // 10-23 是首个窗口，较上期必须显示占位符而不是 0
    expect(html).toContain('—');
  });

  it('结论条报出累计检查次数与区间总变化', () => {
    const html = render(HISTORY);
    expect(html).toContain('累计检查');
    // 共 4 次扫描
    expect(html).toContain('>4<');
    // 总变化：86.3（首窗期末）→ 90.3 = +4
    expect(html).toContain('区间总变化');
  });

  it('多次扫描的窗口显示变动维度，单次扫描的窗口标「无变化」', () => {
    const html = render(HISTORY);
    // 10-23 窗口 quality 89.7→86.3 变动，应出现 -3.4 的维度 chip
    expect(html).toContain('-3.4');
    // 10-24 只有一次扫描，维度 delta 全为 0 → 标「无变化」而不是编出一个变化
    expect(html).toContain('无变化');
  });

  it('渲染结果不含 NaN / undefined', () => {
    const html = render(HISTORY);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
  });

  it('单个窗口时不给趋势结论，明确提示样本不足', () => {
    const html = render([HISTORY[0]]);
    expect(html).toContain('还不足以比较趋势');
  });

  it('空历史不渲染区块', () => {
    expect(render([])).toBe('');
  });

  it('稀疏数据必须标出断档：徽章 + 警示条 + 较上期真实跨度', () => {
    const html = render(SPARSE);
    // 10-20 末次 → 10-24 首次 = 4 天，超过日报阈值 1 天
    expect(html).toContain('断档 4 天');
    expect(html).toContain('有 1 段数据断档');
    expect(html).toContain('断到 2026-10-24');
    // 较上期那两个数字底下必须写清它跨了 4 天，而不是让人当成「一天的变化」
    expect(html).toContain('跨 4 天');
  });

  it('稀疏数据覆盖率按应有天数算：5 个日窗口里只有 2 个有数据', () => {
    const html = render(SPARSE);
    expect(html).toContain('覆盖率');
    expect(html).toContain('40%');
  });

  it('密集数据不得出现任何断档文案（防止把所有窗口都标成缺口）', () => {
    const html = render(HISTORY);
    expect(html).not.toContain('断档');
    expect(html).toContain('100%');
  });
});

import { describe, it, expect } from 'vitest';
import { severityRank, failOnRank, isFailOnValue, FAIL_ON_VALUES } from '../machine-formatters';

// 阈值秩函数是 CLI 门禁判定的数学核心：
// shouldBlock 以 `severityRank(severity) >= failOnRank(failOn)` 决定流水线是否拦停。
// 秩的相对关系一旦漂移（如 warning 秩反超 error），门禁语义会静默反转——
// 该修的不拦、不该修的拦停，两类事故都会侵蚀用户对门禁的信任。

describe('severityRank / failOnRank — 门禁阈值秩', () => {
  it('严重级秩严格递增：info < warning < error——高严重级必须恒不低于低严重级', () => {
    expect(severityRank('info')).toBeLessThan(severityRank('warning'));
    expect(severityRank('warning')).toBeLessThan(severityRank('error'));
    expect(severityRank('error')).toBe(3);
    expect(severityRank('warning')).toBe(2);
    expect(severityRank('info')).toBe(1);
  });

  it('fail-on 秩与严重级同尺度：error/warning/info 对应 3/2/1', () => {
    expect(failOnRank('error')).toBe(3);
    expect(failOnRank('warning')).toBe(2);
    expect(failOnRank('info')).toBe(1);
  });

  it('fail-on=none 恒为 0——「永不阻断」必须低于任何严重级，否则 none 档失效', () => {
    expect(failOnRank('none')).toBe(0);
    expect(failOnRank('none')).toBeLessThan(severityRank('info'));
  });

  it('阈值判定组合语义：warning 违规在 error 阈值下放行、在 warning 阈值下拦停、在 none 阈值下放行', () => {
    // 与 commands.ts shouldBlock 完全一致的表达式：'none' 由显式短路条件兜住，
    // failOnRank('none')=0 的作用是让秩函数在全值域上保持全序（恒低于任何严重级）
    const blocks = (severity: 'error' | 'warning' | 'info', failOn: 'error' | 'warning' | 'info' | 'none') =>
      failOn !== 'none' && severityRank(severity) >= failOnRank(failOn);

    expect(blocks('warning', 'error')).toBe(false);
    expect(blocks('warning', 'warning')).toBe(true);
    expect(blocks('error', 'error')).toBe(true);
    expect(blocks('info', 'info')).toBe(true);
    expect(blocks('error', 'none')).toBe(false);
  });
});

describe('isFailOnValue / FAIL_ON_VALUES — CLI 解析边界校验的单一事实来源', () => {
  it('合法值列表完整且有序：error | warning | info | none——帮助文案直接复用此列表', () => {
    expect([...FAIL_ON_VALUES]).toEqual(['error', 'warning', 'info', 'none']);
  });

  it('所有合法值均通过校验', () => {
    for (const v of FAIL_ON_VALUES) {
      expect(isFailOnValue(v)).toBe(true);
    }
  });

  it('非法值、空串、undefined 一律拒绝——非法阈值静默降级会让门禁形同虚设', () => {
    expect(isFailOnValue('critical')).toBe(false);
    expect(isFailOnValue('ERROR')).toBe(false); // 大小写敏感，杜绝歧义匹配
    expect(isFailOnValue('')).toBe(false);
    expect(isFailOnValue(undefined)).toBe(false);
  });
});

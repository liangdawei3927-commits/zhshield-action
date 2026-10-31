import { describe, it, expect } from 'vitest';
import {
  debtIndexColor,
  debtIndexDisplay,
  DEBT_CATEGORY_CONFIG,
  DEBT_CATEGORY_ORDER,
  ACTION_STATUS_CONFIG,
  INTEREST_FACTOR_CONFIG,
  INTEREST_FACTOR_MAX,
} from '../pages/tech-debt-logic';

const CATEGORY_LABEL_RE = /^page\.techdebt\.category\./;
const STATUS_LABEL_RE = /^page\.techdebt\.status\./;

describe('debtIndexColor', () => {
  it('returns danger for index >= 70', () => {
    expect(debtIndexColor(70)).toBe('rgb(var(--zh-danger))');
    expect(debtIndexColor(100)).toBe('rgb(var(--zh-danger))');
  });

  it('returns warning for 40 <= index < 70', () => {
    expect(debtIndexColor(40)).toBe('rgb(var(--zh-warning))');
    expect(debtIndexColor(69)).toBe('rgb(var(--zh-warning))');
  });

  it('returns success for index < 40', () => {
    expect(debtIndexColor(0)).toBe('rgb(var(--zh-success-700))');
    expect(debtIndexColor(39)).toBe('rgb(var(--zh-success-700))');
  });
});

describe('debtIndexDisplay（缺快照不得渲染成 0 债务）', () => {
  it('debtIndex=null（无体检快照 / 引擎不可用）显示未检测且不染色', () => {
    // 这条是 C4 的落点：把「没算出」渲染成 0 会让用户读成「零债务」，比不显示分数更误导。
    expect(debtIndexDisplay(null, '未检测')).toEqual({ value: '未检测' });
  });

  it('有指数时仍走同一套分档颜色', () => {
    expect(debtIndexDisplay(80, '未检测')).toEqual({
      value: 80,
      color: 'rgb(var(--zh-danger))',
    });
  });
});

describe('DEBT_CATEGORY_CONFIG', () => {
  it('has all 5 categories with color, bg, and labelKey', () => {
    for (const cat of DEBT_CATEGORY_ORDER) {
      const cfg = DEBT_CATEGORY_CONFIG[cat];
      expect(cfg).toBeDefined();
      expect(cfg.color).toBeTruthy();
      expect(cfg.bg).toBeTruthy();
      expect(cfg.labelKey).toMatch(CATEGORY_LABEL_RE);
    }
  });
});

describe('ACTION_STATUS_CONFIG', () => {
  it('covers all 5 statuses: pending, planned, in-progress, repaid, dismissed', () => {
    for (const status of ['pending', 'planned', 'in-progress', 'repaid', 'dismissed']) {
      const cfg = ACTION_STATUS_CONFIG[status];
      expect(cfg).toBeDefined();
      expect(cfg.color).toBeTruthy();
      expect(cfg.labelKey).toMatch(STATUS_LABEL_RE);
    }
  });
});

describe('INTEREST_FACTOR_CONFIG', () => {
  it('has exactly 4 factors', () => {
    expect(INTEREST_FACTOR_CONFIG).toHaveLength(4);
  });

  it('each factor has a valid key', () => {
    for (const f of INTEREST_FACTOR_CONFIG) {
      expect(['severityFactor', 'hotnessFactor', 'densityFactor', 'exposureFactor']).toContain(
        f.key,
      );
    }
  });

  it('INTEREST_FACTOR_MAX is 3', () => {
    expect(INTEREST_FACTOR_MAX).toBe(3);
  });
});

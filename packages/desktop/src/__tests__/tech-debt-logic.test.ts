import { describe, it, expect } from 'vitest';
import {
  debtIndexColor,
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

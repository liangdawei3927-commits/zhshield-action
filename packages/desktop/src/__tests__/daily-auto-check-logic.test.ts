import { describe, expect, it } from 'vitest';
import { dailyAutoKey, localDayKey, needsDailyRun } from '../hooks/daily-auto-check-logic';

describe('daily-auto-check-logic', () => {
  it('无记录 → 需要跑，返回今天的日期键', () => {
    const now = new Date(2026, 8, 19, 14, 30); // 2026-9-19 本地时区
    expect(needsDailyRun(null, now)).toBe('2026-9-19');
  });

  it('今天已跑过 → 不再跑', () => {
    const now = new Date(2026, 8, 19, 23, 59);
    expect(needsDailyRun('2026-9-19', now)).toBeNull();
  });

  it('昨天跑过、今天 0 点刚过 → 需要跑', () => {
    const now = new Date(2026, 8, 19, 0, 1);
    expect(needsDailyRun('2026-9-18', now)).toBe('2026-9-19');
  });

  it('跨月 / 跨年边界按本地时区正确翻日', () => {
    expect(needsDailyRun('2026-8-31', new Date(2026, 8, 1, 0, 0))).toBe('2026-9-1');
    expect(needsDailyRun('2025-12-31', new Date(2026, 0, 1, 0, 0))).toBe('2026-1-1');
  });

  it('localDayKey 用本地时区字段而非 UTC', () => {
    // 本地 2026-3-8 06:00 若在 UTC+8 即 UTC 前一天 —— 断言取本地日期
    const d = new Date(2026, 2, 8, 6, 0);
    expect(localDayKey(d)).toBe('2026-3-8');
  });

  it('存储键按页面与项目路径隔离', () => {
    const a = dailyAutoKey('inspect', '/repo/demo');
    const b = dailyAutoKey('refactor', '/repo/demo');
    const c = dailyAutoKey('inspect', '/repo/other');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe('zhshield:daily-auto:inspect:/repo/demo');
  });
});

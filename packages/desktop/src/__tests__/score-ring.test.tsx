import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScoreRing } from '../components/business/ScoreRing';
import { I18nProvider } from '../i18n';

/**
 * 圆心数字必须与圆弧/等级同源（2026-10-02 回归）。
 *
 * 原实现里圆弧 dashoffset、grade、gradeColor、gradeLetter 全部用收敛后的
 * progress，唯独圆心大数字直接渲染原始 score，于是 score=150 会并排显示
 * 「150」与等级「A」，score=NaN 则把字面量 NaN 渲染到界面上。
 */
function renderRing(score: number): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <ScoreRing score={score} />
    </I18nProvider>,
  );
}

function centerNumber(markup: string): string {
  const match = markup.match(/font-bold[^>]*>(\d+)</);
  return match?.[1] ?? '';
}

describe('ScoreRing 分数收敛', () => {
  it('正常分数原样显示', () => {
    expect(centerNumber(renderRing(87))).toBe('87');
  });

  it('越界高分收敛到 100，不与等级 A 并排矛盾', () => {
    expect(centerNumber(renderRing(150))).toBe('100');
  });

  it('负分收敛到 0', () => {
    expect(centerNumber(renderRing(-20))).toBe('0');
  });

  it('NaN 不渲染字面量 NaN', () => {
    expect(renderRing(Number.NaN)).not.toContain('NaN');
    expect(centerNumber(renderRing(Number.NaN))).toBe('0');
  });

  it('Infinity 同样 fail-closed 收敛到 0（脏数据不得反成满分）', () => {
    expect(centerNumber(renderRing(Number.POSITIVE_INFINITY))).toBe('0');
    expect(centerNumber(renderRing(Number.NEGATIVE_INFINITY))).toBe('0');
  });

  it('圆弧偏移恒为有限非负值（进度弧必须画得出来）', () => {
    for (const score of [Number.NaN, -20, 0, 55, 87, 150, Number.POSITIVE_INFINITY]) {
      const offset = Number(renderRing(score).match(/stroke-dashoffset="([^"]+)"/)?.[1]);
      expect(Number.isFinite(offset), `score=${score} 的 dashoffset 非有限`).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
    }
  });
});
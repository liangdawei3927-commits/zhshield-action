import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dimensionView } from '../pages/reports-logic';

/**
 * 维度渲染语义：not-run（未检测）不得被渲染成 0 分。
 *
 * 背景（2026-09-19）：`@zh/scoring` 的 `buildHealthDimensions` **恒定返回 7 个维度**，
 * 未运行的域以 `{ score: 0, status: 'not-run' }` 保留在数组里（不参与 overall 加权，spec C）。
 * `toHealthScoreData` 是整体透传 `dimensions`，因此 **运行时 status 一路活到渲染层**；
 * 但 `electron.d.ts` 的 `HealthScoreData.dimensions` 漏声明 `status` → 渲染层读不到，
 * `DimensionCards` / `HistoryRow` 便按 `score = 0` 上色 → 用户看到"
 * 从没跑过的安全域得了 0 分（危险红色）"。
 *
 * 这与「记录误导用户」是同一类缺陷：把"没查"显示成"查了、很差"。
 */

/** 假 tr：把请求的 key 原样回显，用于断言文案来源，不依赖 i18n 运行时初始化 */
const tr = (key: string) => `T:${key}`;

describe('dimensionView — not-run 维度不得按 0 分渲染', () => {
  it('not-run 显示「未检测」占位，而不是 0 分 / 危险', () => {
    const v = dimensionView({ score: 0, status: 'not-run' }, tr);
    expect(v.notRun).toBe(true);
    expect(v.scoreText).toBe('—');
    expect(v.label).toBe('T:page.reports.scoreLabel.notRun');
    // 关键：不得回落到"危险"文案
    expect(v.label).not.toBe('T:page.reports.scoreLabel.danger');
  });

  it('真 0 分（已检测）仍如实显示 0 —— 不得被反向吞成「未检测」', () => {
    const v = dimensionView({ score: 0, status: 'scored' }, tr);
    expect(v.notRun).toBe(false);
    expect(v.scoreText).toBe('0');
    expect(v.label).toBe('T:page.reports.scoreLabel.danger');
  });

  it('status 缺省按 scored 处理（旧记录向后兼容）', () => {
    const v = dimensionView({ score: 90 }, tr);
    expect(v.notRun).toBe(false);
    expect(v.scoreText).toBe('90');
    expect(v.label).toBe('T:page.reports.scoreLabel.excellent');
  });

  it('not-run 用中性灰，与真 0 分的危险红不同色', () => {
    const notRun = dimensionView({ score: 0, status: 'not-run' }, tr);
    const zero = dimensionView({ score: 0, status: 'scored' }, tr);
    expect(notRun.color).not.toBe(zero.color);
  });
});

/**
 * 结构断言：维度渲染只允许经 dimensionView 取色/取文案。
 * 防的是"补了个函数但渲染点各自仍读 d.score"——单测发现不了，要读源码。
 */
describe('维度渲染点必须经 dimensionView（防回归）', () => {
  const read = (rel: string) =>
    readFileSync(new URL(`../pages/${rel}`, import.meta.url), 'utf-8');

  it('reports-parts.tsx（DimensionCards）不再直接对 d.score 上色/取标签', () => {
    const src = read('reports-parts.tsx');
    expect(src).not.toMatch(/getScoreColor\(\s*d\.score\s*\)/);
    expect(src).not.toMatch(/getScoreLabel\(\s*d\.score\s*\)/);
    expect(src).toMatch(/dimensionView\(/);
  });

  it('reports-table.tsx（HistoryRow）不再直接对 d.score 上色/取标签', () => {
    const src = read('reports-table.tsx');
    expect(src).not.toMatch(/getScoreColor\(\s*d\.score\s*\)/);
    expect(src).not.toMatch(/getScoreLabel\(\s*d\.score\s*\)/);
    expect(src).toMatch(/dimensionView\(/);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toChronological } from '../pages/reports-logic';

/**
 * 报告中心历史顺序守卫（P0 回归，2026-10-24）。
 *
 * 事故：主进程 `getScoreHistory` 按 created_at DESC 返回，而页面按「旧 → 新」使用
 * `data.at(-1)` 当最新总分 → 页面长期显示项目史上第一条记录
 * （2026-08-29、98.6 分、5 个维度：安全/质量/架构/依赖/文档），
 * 维度卡片数量也随之在 5 张与 10 张之间漂移。
 *
 * SQL 侧已修（`score-history-order.test.ts` 锁死升序契约）；这里是渲染边界守卫，
 * 保证即使上游再返回倒序，页面显示的「最新」也不会变成「最旧」。
 */

function row(timestamp: string, score: number) {
  return { timestamp, score };
}

describe('toChronological', () => {
  it('倒序输入被翻成升序：末尾 = 最新', () => {
    const desc = [
      row('2026-10-23T19:02:36.000Z', 89.5),
      row('2026-09-08T20:55:04.000Z', 85),
      row('2026-08-29T05:40:09.000Z', 98.6),
    ];
    const asc = toChronological(desc);
    expect(asc.map((r) => r.score)).toEqual([98.6, 85, 89.5]);
    expect(asc.at(-1)!.score).toBe(89.5);
  });

  it('本就升序时保持原样（不引入无谓抖动）', () => {
    const asc = [row('2026-08-01T00:00:00.000Z', 1), row('2026-10-01T00:00:00.000Z', 2)];
    expect(toChronological(asc).map((r) => r.score)).toEqual([1, 2]);
  });

  it('同时间戳保持输入相对顺序（稳定排序，不把同秒记录打乱）', () => {
    const same = [
      row('2026-10-10T10:00:00.000Z', 66),
      row('2026-10-10T10:00:00.000Z', 88),
      row('2026-10-10T10:00:00.000Z', 77),
    ];
    expect(toChronological(same).map((r) => r.score)).toEqual([66, 88, 77]);
  });

  it('时间戳不可解析时保持原位，不把坏数据甩到两端', () => {
    const rows = [row('2026-10-01T00:00:00.000Z', 1), row('not-a-date', 2), row('2026-10-02T00:00:00.000Z', 3)];
    const out = toChronological(rows);
    expect(out.at(-1)!.score).toBe(3); // 「最新」仍是真实最新
    expect(out).toHaveLength(3);
  });

  it('不修改入参（纯函数）', () => {
    const input = [row('2026-10-02T00:00:00.000Z', 2), row('2026-10-01T00:00:00.000Z', 1)];
    const snapshot = input.map((r) => r.score);
    toChronological(input);
    expect(input.map((r) => r.score)).toEqual(snapshot);
  });
});

describe('结构性守卫：拉取历史时必须过一遍顺序规整', () => {
  it('reports-logic 的 fetchHistory 不得直接把原始结果塞进 state', () => {
    const src = readFileSync(resolve(__dirname, '../pages/reports-logic.ts'), 'utf-8');
    expect(src).toContain('setData(toChronological(await getScoreHistory(');
  });
});

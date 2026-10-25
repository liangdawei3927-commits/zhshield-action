/**
 * 重构详情页「重开页面后分类消失」回归（2026-10-25）
 *
 * 用户侧现象：检查完当次能看到分类 tab（重复代码 / 多职责混合 / 超大函数…），
 * 切到别的页面再点回来，只剩「最近一次检查结果」的平铺条目列表 —— 分类没了。
 *
 * 两条独立成因，任一条都会让分类消失：
 *  A) 分类聚合原先绑在**内存 report** 上（`useRefactorPage` 内部 `useSmellGroups(report)`），
 *     而页面渲染用的是 `detailReport = report ?? savedReport`。重开页面后 report 为 null，
 *     落盘完整报告读回来了也不会参与分组 ⇒ groups 为空。
 *  B) `showSnapshot` 是单向下手状态：页面挂载瞬间落盘报告还没读完就先点详情，
 *     `openDetail` 判定「无报告」进快照；报告随后到位却没有退出快照的记录
 *     （SecurityPage 有这条 effect，重构页漏了）⇒ 永久停在平铺列表。
 *
 * 本测试锁两件事：
 *  1) 落盘完整报告（`files[].smells[].ruleId` 结构）**足以**还原分类 —— 数据通道没丢字段；
 *  2) 页面接线没退回旧写法（分组入参必须是 detailReport、必须有退出快照的 effect）。
 *     第 2 条用源码断言：本项目测试环境为 node（无 DOM），页面级 hook 无法真渲染，
 *     与 `category-score-cards.test.tsx` 的结构断言同一做法。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupSmellsByRule } from '../pages/refactor-logic';
import type { RefactorReportData } from '../types/electron';

type SavedReport = RefactorReportData;

/** 一份「落盘完整报告」的最小样本：字段与 `.zhshield/reports/refactor.json` 一致 */
function savedReport(): SavedReport {
  const smell = (
    ruleId: string,
    filePath: string,
    line: number,
    severity: 'error' | 'warning' | 'info' = 'warning',
  ) => ({
    id: `${ruleId}-${line}`,
    ruleId,
    severity,
    message: `${ruleId} @${line}`,
    category: 'refactor' as const,
    location: { filePath, line, column: 1 },
    suggestion: { type: 'Extract Common Function', description: '建议提取公共函数' },
  });

  return {
    timestamp: '2026-10-24T22:35:06.000Z',
    projectRoot: '/proj',
    totalFiles: 3,
    scannedFiles: 3,
    totalSmells: 6,
    byCategory: {},
    bySeverity: { error: 0, warning: 6, info: 0 },
    files: [
      {
        filePath: 'packages/a.ts',
        totalSmells: 4,
        maintainabilityScore: 60,
        refactorPriority: 'high',
        smells: [
          smell('duplicated-code', 'packages/a.ts', 1),
          smell('duplicated-code', 'packages/a.ts', 20),
          smell('mixed-responsibilities', 'packages/a.ts', 40),
          smell('long-method', 'packages/a.ts', 80),
        ],
      },
      {
        filePath: 'packages/b.ts',
        totalSmells: 1,
        maintainabilityScore: 70,
        refactorPriority: 'medium',
        smells: [smell('duplicated-code', 'packages/b.ts', 5)],
      },
      {
        filePath: 'packages/c.ts',
        totalSmells: 1,
        maintainabilityScore: 80,
        refactorPriority: 'low',
        smells: [smell('deep-nesting', 'packages/c.ts', 12)],
      },
    ],
    summary: { needsImmediateAction: 1, totalSmells: 6, filesWithSmells: 3 },
  } as unknown as SavedReport;
}

describe('重构：落盘完整报告 → 分类还原', () => {
  it('落盘结构足以还原出分类（不是只有问题条目）', () => {
    const groups = groupSmellsByRule(savedReport().files);

    // 分类 tab 的条目数就是这些组；顺序按条数降序
    expect(groups.map((g) => g.ruleId)).toEqual([
      'duplicated-code',
      'mixed-responsibilities',
      'long-method',
      'deep-nesting',
    ]);
    expect(groups[0].items).toHaveLength(3);
    // 分类名走 i18n 键，不是裸 ruleId —— 否则 tab 上会显示英文 id
    expect(groups[0].label).toBe('page.refactor.smell.duplicatedCode');
  });

  it('没有报告时分类必然为空 —— 这正是「只绑内存 report」的失效形态', () => {
    // 页面旧写法等价于 groupSmellsByRule(undefined)：重开页面 report=null 时恒空
    expect(groupSmellsByRule([])).toEqual([]);
  });
});

describe('重构详情页接线（防退回旧写法）', () => {
  const pageSource = readFileSync(join(__dirname, '../pages/RefactorPage.tsx'), 'utf-8');
  const logicSource = readFileSync(join(__dirname, '../pages/refactor-logic.ts'), 'utf-8');
  const entrySource = readFileSync(join(__dirname, '../hooks/useDomainDetailEntry.ts'), 'utf-8');

  it('分类聚合的入参必须是 detailReport（含落盘报告），不是内存 report', () => {
    expect(pageSource).toContain('useSmellGroups(detailReport)');
    // 旧写法：useSmellGroups(report) —— 会让落盘报告永远不参与分组
    expect(pageSource).not.toMatch(/useSmellGroups\(\s*report\s*\)/);
  });

  it('useRefactorPage 不再自己聚合分类（否则页面无从传入落盘报告）', () => {
    const body = logicSource.slice(logicSource.indexOf('export function useRefactorPage'));
    expect(body).not.toContain('useSmellGroups(report)');
    expect(body).not.toMatch(/^\s*groups,/m);
  });

  it('快照视图可见性必须是派生判定：报告就绪时压过「看快照」标记', () => {
    // 派生判定可内联也可抽成纯函数（当前抽成了 isSnapshotVisible），但两件事必须都在：
    // ① 调用点是「算出来的值」而非 state；② 判定本体仍是「报告就绪压过标记」
    expect(entrySource).toMatch(
      /const showSnapshot = isSnapshotVisible\(snapshotRequested, detailReport\)/,
    );
    expect(entrySource).toMatch(/return snapshotRequested && detailReport === null;/);
    // 旧形态：直接 useState 下发，报告到位也不会自动失效
    expect(entrySource).not.toMatch(/const \[showSnapshot, setShowSnapshot\] = useState/);
    // 报告读回后要把「点过详情」的意图兑现，否则会退回分类主页（用户视角＝又被弹回）
    expect(entrySource).toContain('if (detailIntent)');
  });
});

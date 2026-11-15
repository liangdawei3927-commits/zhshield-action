import { describe, expect, it } from 'vitest';
import type { GarbageScanReportData } from '../types/electron';
import {
  garbageCheckCoverage,
  garbageTypeStates,
  isGarbageTypeUndetected,
} from '../pages/garbage-type-logic';

/**
 * 「未检测 ≠ 0」回归（垃圾清理类型卡）。
 *
 * 业务背景：扫文档仓库时 ts-prune / depcheck 未执行（画像裁剪 / 无 package.json），
 * 页面曾把它们渲染成 `0`，与「查过且干净」无法区分，用户读成「四个维度全绿」。
 * 本用例锁定：未执行维度必须判为未检测，且原因可回溯到 checks。
 */
function reportOf(
  checks: GarbageScanReportData['checks'],
  byType: Record<string, number> = {},
): GarbageScanReportData {
  return {
    projectPath: '/proj',
    items: [],
    summary: { total: 0, size: 0, byType },
    checks,
    skipped: checks.filter((c) => !c.ran).length,
    timestamp: '2026-11-13T00:00:00.000Z',
  };
}

describe('garbageTypeStates', () => {
  it('未执行的检测项把覆盖类型记成未检测并保留原因', () => {
    const report = reportOf([
      { ruleId: 'garbage.detect.fs', name: '文件系统级垃圾', ran: true, producer: 'detector', garbageTypes: ['unused-file', 'build-artifact'] },
      { ruleId: 'garbage.scan.cleanup.dead-code', name: '死代码检测', ran: false, producer: 'sop-rule', reason: '工具 ts-prune 不在当前项目画像 scope 内', garbageTypes: ['dead-code'] },
      { ruleId: 'garbage.scan.cleanup.unused-dependency', name: '未使用依赖检测', ran: false, producer: 'sop-rule', reason: '目标目录无 package.json', garbageTypes: ['unused-dependency'] },
    ]);
    const states = garbageTypeStates(report);

    expect([...states.covered].sort()).toEqual(['build-artifact', 'dead-code', 'unused-dependency', 'unused-file']);
    expect(states.reasons.get('dead-code')).toEqual(['工具 ts-prune 不在当前项目画像 scope 内']);
    expect(states.reasons.get('unused-dependency')).toEqual(['目标目录无 package.json']);
    expect(states.reasons.has('unused-file')).toBe(false);
  });

  it('同一类型被多个检测项覆盖时，未执行原因全部保留', () => {
    const report = reportOf([
      { ruleId: 'garbage.rules', name: '垃圾规则通道', ran: false, producer: 'sop-rule', reason: '规则通道未执行', garbageTypes: ['dead-code', 'unused-dependency'] },
      { ruleId: 'garbage.scan.cleanup.dead-code', name: '死代码检测', ran: false, producer: 'sop-rule', reason: '工具不可用', garbageTypes: ['dead-code'] },
    ]);
    const states = garbageTypeStates(report);
    expect(states.reasons.get('dead-code')).toEqual(['规则通道未执行', '工具不可用']);
  });
});

describe('isGarbageTypeUndetected', () => {
  it('跑了且无命中的类型不算未检测（0 是真实结果）', () => {
    const states = garbageTypeStates(
      reportOf([
        { ruleId: 'garbage.detect.fs', name: '文件系统级垃圾', ran: true, producer: 'detector', garbageTypes: ['unused-file', 'build-artifact'] },
      ]),
    );
    expect(isGarbageTypeUndetected(states, 'unused-file', true)).toBe(false);
  });

  it('没有检测项覆盖的类型标未检测（重复代码已移交重构域）', () => {
    const states = garbageTypeStates(
      reportOf([
        { ruleId: 'garbage.detect.fs', name: '文件系统级垃圾', ran: true, producer: 'detector', garbageTypes: ['unused-file', 'build-artifact'] },
      ]),
    );
    expect(isGarbageTypeUndetected(states, 'duplicate-code', true)).toBe(true);
  });

  it('旧报告未声明类型归属时退回旧口径，不把全部维度误标未检测', () => {
    const states = garbageTypeStates(
      reportOf([{ ruleId: 'garbage.detect.fs', name: '文件系统级垃圾', ran: true, producer: 'detector' }]),
    );
    expect(isGarbageTypeUndetected(states, 'duplicate-code', false)).toBe(false);
  });
});

/**
 * 「有检测没跑成时不得显示等级」回归（C4）。
 *
 * 实测（2026-11-15，文档仓库）：三项检测只跑了文件系统检测器，条目 0、罚分 0，
 * 顶行照样显示「100 分 · 优秀」——而三张类型卡同时写着「未检测」。覆盖必须交给
 * 评分卡，分数才会改口成「已检测部分均分」。安全页早已这样接线，垃圾页漏了。
 */
describe('garbageCheckCoverage', () => {
  const partialReport = reportOf([
    { ruleId: 'garbage.detect.fs', name: '文件系统级垃圾', ran: true, producer: 'detector', garbageTypes: ['unused-file', 'build-artifact'] },
    { ruleId: 'garbage.scan.cleanup.dead-code', name: '死代码检测', ran: false, producer: 'sop-rule', reason: '本项目不适用该工具（ts-prune），已跳过', garbageTypes: ['dead-code'] },
    { ruleId: 'garbage.scan.cleanup.unused-dependency', name: '未使用依赖检测', ran: false, producer: 'sop-rule', reason: '目标目录无 package.json', garbageTypes: ['unused-dependency'] },
  ]);

  it('三项只跑了一项 → {run:1,total:3}，评分卡据此判 partial', () => {
    expect(garbageCheckCoverage(partialReport)).toEqual({ run: 1, total: 3 });
  });

  it('全部执行 → run 等于 total（评分卡保留等级）', () => {
    const complete = reportOf([
      { ruleId: 'garbage.detect.fs', name: '文件系统级垃圾', ran: true, producer: 'detector', garbageTypes: ['unused-file', 'build-artifact'] },
      { ruleId: 'garbage.scan.cleanup.dead-code', name: '死代码检测', ran: true, producer: 'sop-rule', garbageTypes: ['dead-code'] },
    ]);
    expect(garbageCheckCoverage(complete)).toEqual({ run: 2, total: 2 });
  });

  it('无 checks（历史快照等旧报告）→ undefined，退回旧口径而不是误判 partial', () => {
    expect(garbageCheckCoverage(reportOf([]))).toBeUndefined();
  });
});

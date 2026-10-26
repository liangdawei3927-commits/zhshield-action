/**
 * P0-1 回归：任务落定 → 前端自动刷新（task-settled-refresh.test.ts）
 *
 * 缺陷：各域分数/报告 hook 只在挂载时读一次（切 tab 才重挂载重读）。后台任务
 * （自动巡检/任务中心/另一页发起）完成后，当前页面分数停在 `--`——后端写了库、
 * 前端不重读，用户据此判定「功能是假的」。7 个扫描功能全部复现。
 *
 * 修复：task-store 暴露落定信号（useTaskSettledTick / useDimensionSettledTick /
 * useProjectSettledTick），接进 useDomainScoreView / useHealthOverview /
 * useSavedDomainReport / useDomainSnapshot 的重拉条件。
 *
 * 双自证：
 * - 行为：tick 判定纯函数的真阳性（刚落定必触发）与误报防护（历史/重复广播不触发）；
 * - 接线：四个数据 hook 的源码必须真的消费了 tick（结构守卫，防止改回去）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskInfo } from '../../src/types/electron';
import {
  absorbProjectSettled,
  shouldBumpSettledTick,
  taskKindForDomain,
  type ProjectSettleState,
  type TaskSettleObservation,
} from '../../src/task-store';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.resolve(SRC, rel), 'utf8');

function makeTask(overrides: Partial<TaskInfo> & Pick<TaskInfo, 'id' | 'kind'>): TaskInfo {
  return {
    projectPath: '/p',
    status: 'running',
    progress: 0,
    startedAt: '2026-10-27T00:00:00.000Z',
    ...overrides,
  } as TaskInfo;
}

describe('shouldBumpSettledTick — 落定判定纯谓词', () => {
  const settledTask = { id: 't1', status: 'done' as const };

  it('真阳性：上一帧非终态、本帧落定 → 触发（任务完成的瞬间）', () => {
    const prev: TaskSettleObservation = { id: 't1', settled: false };
    expect(shouldBumpSettledTick(prev, settledTask)).toBe(true);
    // failed / cancelled 同样视为落定（失败也该让界面从 -- 恢复成真实状态）
    expect(shouldBumpSettledTick(prev, { id: 't1', status: 'failed' })).toBe(true);
    expect(shouldBumpSettledTick(prev, { id: 't1', status: 'cancelled' })).toBe(true);
  });

  it('误报防护：挂载时任务已是终态（历史结果）→ 不触发', () => {
    expect(shouldBumpSettledTick(null, settledTask)).toBe(false);
  });

  it('误报防护：同一任务的终态重复广播 → 不重复触发', () => {
    const prev: TaskSettleObservation = { id: 't1', settled: true };
    expect(shouldBumpSettledTick(prev, settledTask)).toBe(false);
  });

  it('换新任务 id：首帧观察不触发（它还会经历非终态，落定时才触发）', () => {
    const prev: TaskSettleObservation = { id: 't0', settled: true };
    expect(shouldBumpSettledTick(prev, settledTask)).toBe(false);
  });

  it('非终态（queued/running）永不触发', () => {
    const prev: TaskSettleObservation = { id: 't1', settled: false };
    expect(shouldBumpSettledTick(prev, { id: 't1', status: 'queued' })).toBe(false);
    expect(shouldBumpSettledTick(prev, { id: 't1', status: 'running' })).toBe(false);
  });
});

describe('absorbProjectSettled — 项目级落定吸收', () => {
  function task(id: string, status: TaskInfo['status'], projectPath = '/p'): TaskInfo {
    return makeTask({ id, kind: 'pipeline', status, projectPath });
  }

  it('历史终态任务（ready 前）只登记不触发；登记后 ready 置位', () => {
    const state: ProjectSettleState = { ready: false, settledIds: new Set() };
    expect(absorbProjectSettled(state, [task('t1', 'done')], '/p')).toBe(false);
    expect(state.ready).toBe(true);
    expect(state.settledIds.has('t1')).toBe(true);
  });

  it('真阳性：ready 后新落定的任务 → 触发', () => {
    const state: ProjectSettleState = { ready: true, settledIds: new Set() };
    expect(absorbProjectSettled(state, [task('t2', 'done')], '/p')).toBe(true);
  });

  it('重复广播去重：同一任务第二次落定推送不触发', () => {
    const state: ProjectSettleState = { ready: true, settledIds: new Set() };
    expect(absorbProjectSettled(state, [task('t2', 'done')], '/p')).toBe(true);
    expect(absorbProjectSettled(state, [task('t2', 'done')], '/p')).toBe(false);
  });

  it('只看本项目：其他项目的任务落定不触发本项目刷新', () => {
    const state: ProjectSettleState = { ready: true, settledIds: new Set() };
    expect(absorbProjectSettled(state, [task('t3', 'done', '/other')], '/p')).toBe(false);
    expect(state.settledIds.has('t3')).toBe(false);
  });

  it('空列表不置 ready（初始列表异步拉回前不能误判历史划界）', () => {
    const state: ProjectSettleState = { ready: false, settledIds: new Set() };
    expect(absorbProjectSettled(state, [], '/p')).toBe(false);
    expect(state.ready).toBe(false);
  });
});

describe('taskKindForDomain — 域名/维度 ↔ 任务类型映射', () => {
  it('两套命名指向同一任务：quality=inspect→pipeline、gate=guard、dependencies=deps', () => {
    expect(taskKindForDomain('quality')).toBe('pipeline');
    expect(taskKindForDomain('inspect')).toBe('pipeline');
    expect(taskKindForDomain('gate')).toBe('guard');
    expect(taskKindForDomain('guard')).toBe('guard');
    expect(taskKindForDomain('dependencies')).toBe('deps');
    expect(taskKindForDomain('deps')).toBe('deps');
    expect(taskKindForDomain('techdebt')).toBe('techdebt');
    expect(taskKindForDomain('refactor')).toBe('refactor');
    expect(taskKindForDomain('performance')).toBe('performance');
    expect(taskKindForDomain('garbage')).toBe('garbage');
    expect(taskKindForDomain('security')).toBe('security');
    expect(taskKindForDomain('secrets')).toBe('security');
  });

  it('无对应任务的维度返回 undefined（sentinel 持续监控 / backup 独立链路）', () => {
    expect(taskKindForDomain('sentinel')).toBeUndefined();
    expect(taskKindForDomain('backup')).toBeUndefined();
    expect(taskKindForDomain('unknown-domain')).toBeUndefined();
  });
});

describe('结构守卫 — 数据 hook 必须消费落定信号（防止改回「只挂载读一次」）', () => {
  it('useDomainScoreView：引入 useDimensionSettledTick 并进重拉依赖', () => {
    const src = read('src/hooks/useDomainScoreView.ts');
    expect(src).toContain('useDimensionSettledTick(dimension, projectPath)');
    expect(src).toMatch(/\[projectPath,\s*dimension,\s*live,\s*refreshKey,\s*settledTick\]/);
  });

  it('useHealthOverview：引入 useProjectSettledTick 并进重拉依赖', () => {
    const src = read('src/hooks/useHealthOverview.ts');
    expect(src).toContain('useProjectSettledTick(projectPath)');
    expect(src).toMatch(/\[load,\s*refreshKey,\s*settledTick\]/);
  });

  it('useSavedDomainReport：读回 effect 依赖含落定 tick', () => {
    const src = read('src/hooks/useSavedDomainReport.ts');
    expect(src).toContain('useTaskSettledTick(taskKindForDomain(domain), projectPath)');
    expect(src).toMatch(/\[projectPath,\s*domain,\s*settledTick\]/);
  });

  it('useDomainSnapshot：读盘 effect 依赖含落定 tick', () => {
    const src = read('src/hooks/useDomainSnapshot.ts');
    expect(src).toContain('useTaskSettledTick(taskKindForDomain(domain), projectPath)');
    expect(src).toMatch(/\[projectPath,\s*domain,\s*tick,\s*settledTick\]/);
  });

  it('task-store 必须导出三个信号 hook 与映射（下游接线的前提）', () => {
    const src = read('src/task-store.ts');
    expect(src).toContain('export function useTaskSettledTick');
    expect(src).toContain('export function useDimensionSettledTick');
    expect(src).toContain('export function useProjectSettledTick');
    expect(src).toContain('export function taskKindForDomain');
  });
});

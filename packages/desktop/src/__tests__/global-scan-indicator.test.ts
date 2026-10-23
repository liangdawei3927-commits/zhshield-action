import { describe, expect, it } from 'vitest';
import type { TaskInfo, TaskKind } from '../types/electron';
import {
  countActiveTasks,
  isActiveTask,
  pickActiveTask,
} from '../components/layout/global-scan-indicator-logic';
import { navIdForTaskKind } from '../components/layout/nav-items';

function task(overrides: Partial<TaskInfo> & { id: string }): TaskInfo {
  return {
    kind: 'pipeline',
    projectPath: '/tmp/demo',
    status: 'running',
    progress: 0.5,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('global-scan-indicator: 活动任务选取', () => {
  it('无任务时不展示', () => {
    expect(pickActiveTask([])).toBeUndefined();
  });

  it('只有已完成/失败/取消的任务时不展示', () => {
    const tasks = [
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'failed' }),
      task({ id: 'c', status: 'cancelled' }),
    ];
    expect(pickActiveTask(tasks)).toBeUndefined();
    expect(countActiveTasks(tasks)).toBe(0);
  });

  it('运行中优先于排队中，即使排队任务更晚发起', () => {
    const tasks = [
      task({ id: 'running', status: 'running', startedAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'queued', status: 'queued', startedAt: '2026-01-01T00:00:09.000Z' }),
    ];
    expect(pickActiveTask(tasks)?.id).toBe('running');
  });

  it('多个运行中任务取最近发起的那条', () => {
    const tasks = [
      task({ id: 'old', startedAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 'new', startedAt: '2026-01-01T00:00:05.000Z' }),
    ];
    expect(pickActiveTask(tasks)?.id).toBe('new');
  });

  it('没有运行中任务时退回排队任务', () => {
    const tasks = [task({ id: 'q1', status: 'queued' }), task({ id: 'q2', status: 'queued' })];
    expect(pickActiveTask(tasks)?.id).toBe('q2');
  });

  it('活动任务计数只含运行中与排队中', () => {
    const tasks = [
      task({ id: 'a', status: 'running' }),
      task({ id: 'b', status: 'queued' }),
      task({ id: 'c', status: 'done' }),
    ];
    expect(countActiveTasks(tasks)).toBe(2);
    expect(tasks.filter(isActiveTask).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('global-scan-indicator: 任务类型反查导航分类', () => {
  it('pipeline 归巡检页（own 优先于借用方 deps/techdebt）', () => {
    expect(navIdForTaskKind('pipeline')).toBe('inspect');
  });

  it('独立任务类型映射到自身分类', () => {
    expect(navIdForTaskKind('guard')).toBe('guard');
    expect(navIdForTaskKind('security')).toBe('security');
    expect(navIdForTaskKind('refactor')).toBe('refactor');
  });

  it('未在任何分类登记的 kind 返回 undefined', () => {
    expect(navIdForTaskKind('unknown-kind' as TaskKind)).toBeUndefined();
  });
});

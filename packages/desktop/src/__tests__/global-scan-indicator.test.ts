import { describe, expect, it } from 'vitest';
import type { TaskInfo, TaskKind } from '../types/electron';
import {
  countActiveTasks,
  isActiveTask,
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

// ⚠️ 浮窗专属的 pickActiveTask（选中要展示的那条任务）已于 2026-10-26 随右下角
// GlobalScanIndicator 一并删除，其 4 条用例同时移除。本文件剩下的部分测的是
// 仍被 useDailyAutoCheck 消费的 countActiveTasks / isActiveTask。
describe('活动任务计数（useDailyAutoCheck 去重用）', () => {
  it('只有已完成/失败/取消的任务时计数为 0', () => {
    const tasks = [
      task({ id: 'a', status: 'done' }),
      task({ id: 'b', status: 'failed' }),
      task({ id: 'c', status: 'cancelled' }),
    ];
    expect(countActiveTasks(tasks)).toBe(0);
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

describe('nav-items: 任务类型反查导航分类', () => {
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

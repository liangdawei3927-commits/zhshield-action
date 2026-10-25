import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTO_DEFER_MAX_MS,
  ranToday,
  shouldDeferAutoRun,
} from '../hooks/daily-auto-check-logic';

/**
 * 后台自动检查「让路」守卫（2026-10-25）。
 *
 * 背景：主进程 TaskManager 的并发上限是 2（electron/task-manager.ts 的 MAX_CONCURRENT），
 * 而体检页与重构页「每天首次进入各自动跑一次」——两个自动任务正好占满两个槽位。
 * 此后用户在任何分类页点主操作按钮，任务只能排队；而按钮显示的仍是「扫描中...」，
 * 与真正在跑完全无法区分（归属页的全局指示器被刻意隐藏，排队信息无处可见）。
 *
 * 修法不是给按钮加字，而是让**后台自动检查不与用户主动操作抢槽**：
 * 存在活动任务时延后，等到系统空闲再跑；一直不空闲则放弃本次（且不写今日记录）。
 */

const read = (rel: string): string => readFileSync(resolve(__dirname, '..', rel), 'utf8');

describe('shouldDeferAutoRun：槽位忙就让路', () => {
  it('系统空闲（0 个活动任务）→ 立刻跑', () => {
    expect(shouldDeferAutoRun(0)).toBe(false);
  });

  it('已有 1 个活动任务 → 让路（保住最后一个槽给用户点击）', () => {
    expect(shouldDeferAutoRun(1)).toBe(true);
  });

  it('两个槽位都占满 → 让路', () => {
    expect(shouldDeferAutoRun(2)).toBe(true);
  });
});

describe('ranToday：今天已经跑过同 kind 同项目就不再补跑', () => {
  const now = new Date(2026, 9, 25, 18, 0); // 2026-10-25 本地时区
  const todayIso = new Date(2026, 9, 25, 9, 30).toISOString();
  const yesterdayIso = new Date(2026, 9, 24, 23, 0).toISOString();

  it('今日同 kind 同项目已有任务（用户手动跑过也算）→ true', () => {
    const tasks = [{ kind: 'pipeline', projectPath: '/repo/a', startedAt: todayIso }];
    expect(ranToday(tasks, 'pipeline', '/repo/a', now)).toBe(true);
  });

  it('昨日跑过 → false（今天该补跑）', () => {
    const tasks = [{ kind: 'pipeline', projectPath: '/repo/a', startedAt: yesterdayIso }];
    expect(ranToday(tasks, 'pipeline', '/repo/a', now)).toBe(false);
  });

  it('别的 kind（如重构页的 refactor）不算体检跑过', () => {
    const tasks = [{ kind: 'refactor', projectPath: '/repo/a', startedAt: todayIso }];
    expect(ranToday(tasks, 'pipeline', '/repo/a', now)).toBe(false);
  });

  it('别的项目不算', () => {
    const tasks = [{ kind: 'pipeline', projectPath: '/repo/b', startedAt: todayIso }];
    expect(ranToday(tasks, 'pipeline', '/repo/a', now)).toBe(false);
  });

  it('空任务表 → false', () => {
    expect(ranToday([], 'pipeline', '/repo/a', now)).toBe(false);
  });

  it('状态不影响判定：cancelled 也算今天跑过（用户明确取消过，不自动补跑骚扰）', () => {
    const tasks = [
      { kind: 'pipeline', projectPath: '/repo/a', startedAt: todayIso, status: 'cancelled' },
    ];
    expect(ranToday(tasks, 'pipeline', '/repo/a', now)).toBe(true);
  });
});

describe('等待上限', () => {
  it('是正数且足够长（避免用户刚开始用就被放弃），又不至于无限等', () => {
    expect(AUTO_DEFER_MAX_MS).toBeGreaterThanOrEqual(60_000);
    expect(AUTO_DEFER_MAX_MS).toBeLessThanOrEqual(10 * 60_000);
  });
});

/**
 * 结构断言：hook 是薄胶水，decision 全在纯函数里。
 *
 * 上面测的是"判断对了"，这里测"判断真的被接上"。少一处接线 = 门禁全绿但行为没变
 * —— 本项目已有前科（技能里「声明了却没执行」十形态）。
 */
describe('useDailyAutoCheck 接线守卫', () => {
  const src = read('hooks/useDailyAutoCheck.ts');

  it('必须调用让路判据与今日已跑判据', () => {
    expect(src).toMatch(/shouldDeferAutoRun\(/);
    expect(src).toMatch(/ranToday\(/);
  });

  it('今日记录只允许一个写入点，且必须排在让路判据之后（禁止"先写记录再跑"）', () => {
    const callSites = src.split('\n').filter((l) => l.includes('writeStoredAuto(scope, projectPath'));
    expect(callSites).toHaveLength(1);

    const lines = src.split('\n');
    const writeIdx = lines.findIndex((l) => l.includes('writeStoredAuto(scope, projectPath'));
    const deferIdx = lines.findIndex((l) => l.includes('shouldDeferAutoRun('));
    expect(deferIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(deferIdx);
  });

  it('放弃路径不得写今日记录（只清 pending）', () => {
    // 超时放弃分支：return 前只有 setPending(null)，没有 writeStoredAuto
    expect(src).toMatch(/remaining\s*<=\s*0/);
    expect(src).toMatch(/AUTO_DEFER_MAX_MS/);
  });
});

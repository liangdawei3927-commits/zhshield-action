/**
 * P2-8 回归：忙态耗时可见（task-elapsed.test.ts）
 *
 * 缺陷：扫描点击后 1–10 分钟才出结果，进度条只有阶段消息没有耗时，
 * 用户无法区分「在跑」和「卡死」（P0-2 的僵尸任务加剧了这一观感）。
 *
 * 修复：useTaskRun 忙态期间每秒计时，statusMessage 携带「已用时 m:ss」
 * （与任务阶段消息拼接），经 PageShell 进度条链路展示，页面零改动。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatElapsed } from '../task-store';

const SRC = path.resolve(__dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.resolve(SRC, rel), 'utf8');

describe('formatElapsed — 秒 → m:ss', () => {
  it('不足 1 分钟补零：0:05', () => {
    expect(formatElapsed(5)).toBe('0:05');
  });

  it('超过 1 分钟：1:23', () => {
    expect(formatElapsed(83)).toBe('1:23');
  });

  it('超过 1 小时不进位到小时（扫描不应跑 1 小时；超时看门狗会先杀）', () => {
    expect(formatElapsed(3725)).toBe('62:05');
  });

  it('负数与 NaN 输入钳到 0:00', () => {
    expect(formatElapsed(-3)).toBe('0:00');
    expect(formatElapsed(Number.NaN)).toBe('0:00');
  });
});

describe('结构守卫 — useTaskRun 忙态必须携带耗时', () => {
  const src = read('src/task-store.ts');

  it('TaskRunState 暴露 elapsedText 字段', () => {
    expect(src).toMatch(/elapsedText:\s*string;/);
  });

  it('计时 hook 忙态才挂每秒定时器（空闲不空转）', () => {
    expect(src).toContain('setInterval(() => forceTick((n) => n + 1), 1000)');
    expect(src).toMatch(/if \(!active \|\| !startedAt\) return;/);
  });

  it('running 态 statusMessage = 任务消息 + 已用时（不丢原阶段消息）', () => {
    expect(src).toMatch(/\[task\.message\?\.trim\(\),\s*elapsedText\]\.filter\(Boolean\)\.join\(' · '\)/);
  });

  it('queued 态 statusMessage 也带耗时（排队等位时长可感知）', () => {
    // queued 分支的 statusMessage 必须引用 elapsedText（而非空串）
    const branchMarker = "if (task.status === 'queued') {";
    const branchStart = src.indexOf(branchMarker);
    expect(branchStart, 'useTaskRun 应有 queued 分支').toBeGreaterThan(0);
    const queuedBlock = src.slice(branchStart, branchStart + 900);
    expect(queuedBlock).toMatch(/statusMessage:\s*elapsedText/);
  });

  it('i18n 五语言均有 task.elapsedLabel 键', () => {
    const localesDir = path.resolve(SRC, '../i18n/locales');
    for (const lng of ['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko']) {
      const json = JSON.parse(fs.readFileSync(path.join(localesDir, `${lng}.json`), 'utf-8'));
      expect(typeof json.task?.elapsedLabel, `${lng}.task.elapsedLabel`).toBe('string');
      expect(json.task.elapsedLabel).toContain('{{time}}');
    }
  });
});

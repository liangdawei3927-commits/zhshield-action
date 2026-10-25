/**
 * 失效历史事件收敛的判据测试（out-of-scope-prune）。
 *
 * 这组用例钉的是「修好生成端之后的另一半」：库里旧事件要不要清、清哪些。
 * 三条判据都不按时间/条数，而是问**事件描述的状态是否还成立**：
 *   A. 路径按当前监控口径已越界；
 *   B. unlink 事件的目标已回到磁盘（删除没落地）；
 *   C. unlink 的目标未回盘、路径不属交付物（不在 git 索引）且已过保留窗口
 *      —— 临时文件/探针脚本的正常生命周期，删了就是删了。
 * 因此每条用例都用真实形态的路径断言，且文件存在性 / git 索引一律注入，不碰真实磁盘。
 */

import { describe, expect, it } from 'vitest';

import {
  collectStaleEventIds,
  readEventFilePath,
  PRUNABLE_MODULE,
  type PrunableEventLike,
} from '../out-of-scope-prune';

const PROJECT = '/Users/dawei/Desktop/ZHCodeShield';
/** 默认「目标不在磁盘上」：只让判据 A 生效，避免两条判据互相干扰 */
const missing = (): boolean => false;

function row(
  id: string,
  filePath: string,
  options?: { changeType?: string; module?: string; timestamp?: string },
): PrunableEventLike {
  return {
    id,
    module: options?.module ?? PRUNABLE_MODULE,
    context: JSON.stringify({ filePath, changeType: options?.changeType ?? 'add' }),
    ...(options?.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
  };
}

/** 判据 C 的「现在」与「一天前」 */
const NOW = Date.parse('2026-10-25T18:00:00.000Z');
const YESTERDAY = new Date(NOW - 25 * 60 * 60 * 1000).toISOString();
const JUST_NOW = new Date(NOW - 60 * 1000).toISOString();

describe('readEventFilePath 从 context 取路径', () => {
  it('JSON 字符串形态（DB 行）能解析', () => {
    expect(readEventFilePath('{"filePath":"/a/b/c.ts"}')).toBe('/a/b/c.ts');
  });

  it('对象形态（内存态）也能解析', () => {
    expect(readEventFilePath({ filePath: '/a/b/c.ts' })).toBe('/a/b/c.ts');
  });

  it('损坏 JSON / 缺字段 / 空串 一律返回 null（宁可留噪音，不可误删）', () => {
    expect(readEventFilePath('{not json')).toBeNull();
    expect(readEventFilePath({ changeType: 'unlink' })).toBeNull();
    expect(readEventFilePath({ filePath: '' })).toBeNull();
    expect(readEventFilePath(null)).toBeNull();
  });
});

describe('判据 A：路径按当前监控口径已越界', () => {
  it('build-output 下的重建产物 → 收敛', () => {
    const rows = [
      row('e1', `${PROJECT}/build-output/mac/智汇码盾.app/Contents/Resources/locale.pak`, {
        changeType: 'unlink',
      }),
      row('e2', `${PROJECT}/build-output/mac/LICENSE`, { changeType: 'add' }),
    ];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: missing })).toEqual(['e1', 'e2']);
  });

  it('macOS 应用包内文件（.app/.framework）→ 收敛', () => {
    const rows = [
      row('e3', `${PROJECT}/release/MyApp.app/Contents/MacOS/MyApp`, { changeType: 'unlink' }),
      row('e4', `${PROJECT}/node_modules/electron/dist/Electron.app/Contents/Info.plist`, {
        changeType: 'change',
      }),
    ];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: missing })).toEqual(['e3', 'e4']);
  });

  it('自定义 ignoreDirs 生效（与监控同口径，而不是各写一份）', () => {
    const rows = [row('c1', `${PROJECT}/vendor/lib.ts`)];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: missing })).toEqual([]);
    expect(
      collectStaleEventIds(rows, PROJECT, { ignoreDirs: ['vendor'], fileExists: missing }),
    ).toEqual(['c1']);
  });
});

describe('判据 B：unlink 事件的目标仍在磁盘（删除没落地）', () => {
  it('unlink 且文件仍在（git 恢复 / 报告重新生成）→ 收敛', () => {
    const target = `${PROJECT}/智汇码盾复查报告-2026-09-14.html`;
    const rows = [row('r1', target, { changeType: 'unlink' })];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: (p) => p === target })).toEqual([
      'r1',
    ]);
  });

  it('unlink 且文件确实不在 → 保留（真实删除不能被吞掉）', () => {
    const rows = [row('r2', `${PROJECT}/旧报告.html`, { changeType: 'unlink' })];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: missing })).toEqual([]);
  });

  it('文件存在但事件类型是 add/change → 保留（存在正是正常态）', () => {
    const target = `${PROJECT}/zhihui-codeshield/packages/sentinel/src/file-monitor.ts`;
    const rows = [
      row('r3', target, { changeType: 'change' }),
      row('r4', target, { changeType: 'add' }),
    ];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: () => true })).toEqual([]);
  });
});

describe('判据 C：删除已既定、且删的不是交付物', () => {
  it('未跟踪的临时文件、超过保留窗口 → 收敛（真阳性：18 条 p2 unlink 就是这个形态）', () => {
    const rows = [
      row('u1', `${PROJECT}/zhihui-codeshield/packages/sentinel/.probe.cjs`, {
        changeType: 'unlink',
        timestamp: YESTERDAY,
      }),
      row('u2', `${PROJECT}/zhihui-codeshield/packages/desktop/scripts/tmp-preview.tsx`, {
        changeType: 'unlink',
        timestamp: YESTERDAY,
      }),
    ];
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: missing,
        isTracked: () => false,
        now: NOW,
      }),
    ).toEqual(['u1', 'u2']);
  });

  it('被跟踪的交付物删除 → 保留（真实删除不能被吞掉）', () => {
    const target = `${PROJECT}/智汇码盾复查报告-2026-09-14.html`;
    const rows = [row('t1', target, { changeType: 'unlink', timestamp: YESTERDAY })];
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: missing,
        isTracked: (p) => p === target,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('目录形态：其下有被跟踪的文件 → 保留（整树删除仍需告警）', () => {
    const rows = [
      row('d1', `${PROJECT}/packages/core`, { changeType: 'unlink', timestamp: YESTERDAY }),
    ];
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: missing,
        // 目录形态的「其下有跟踪文件」由 git-index 负责推导（见 git-index.test.ts），
        // 这里只钉「判定器说属交付物 ⇒ 判据 C 不成立」。
        isTracked: (p) => p === `${PROJECT}/packages/core`,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('刚删的临时文件仍在保留窗口内 → 保留（删除当下要可审计）', () => {
    const rows = [
      row('w1', `${PROJECT}/tmp-live.ts`, { changeType: 'unlink', timestamp: JUST_NOW }),
    ];
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: missing,
        isTracked: () => false,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('索引不可判定（null / 未提供）→ 保留，绝不因读不到 git 而误删', () => {
    const rows = [row('n1', `${PROJECT}/tmp-x.ts`, { changeType: 'unlink', timestamp: YESTERDAY })];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: missing, now: NOW })).toEqual([]);
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: missing,
        isTracked: () => null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('缺 timestamp → 判据 C 不成立（无法算窗口，宁可留着）', () => {
    const rows = [row('m1', `${PROJECT}/tmp-y.ts`, { changeType: 'unlink' })];
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: missing,
        isTracked: () => false,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('文件已回盘仍走判据 B（与 C 不冲突）', () => {
    const target = `${PROJECT}/tmp-z.ts`;
    const rows = [row('b1', target, { changeType: 'unlink', timestamp: YESTERDAY })];
    expect(
      collectStaleEventIds(rows, PROJECT, {
        fileExists: (p) => p === target,
        isTracked: () => false,
        now: NOW,
      }),
    ).toEqual(['b1']);
  });
});

describe('不动的边界：非文件级模块 / 缺路径 / 坏 context', () => {
  it('process-monitor 事件与异常 context 一律保留', () => {
    const rows: PrunableEventLike[] = [
      row('p1', `${PROJECT}/build-output/mac/LICENSE`, { module: 'process-monitor' }),
      { id: 'p2', module: PRUNABLE_MODULE, context: JSON.stringify({ changeType: 'unlink' }) },
      { id: 'p3', module: PRUNABLE_MODULE, context: '{broken' },
    ];
    expect(collectStaleEventIds(rows, PROJECT, { fileExists: () => true })).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { MIN_BACKUP_KEEP, normalizeKeepCount } from '../backup/retention';
import { LocalBackupPruner } from '../backup/local-backup-pruner';

/**
 * 备份保留策略护栏（2026-09-18）
 *
 * 回归目标：`dirs.slice(maxBackups)` 在 `maxBackups = 0` 时等于 `slice(0)`，
 * 也就是**把全部备份删光**。而 `listBackups()` 返回新→旧排序，所以「保留份数」
 * 一旦被配置成 0（UI 可改项），备份中心会亲手删掉用户的所有备份。
 *
 * 护栏落在唯一的删除入口 `LocalBackupPruner`，本文件同时锁住纯函数与真实删除行为。
 */
describe('normalizeKeepCount（保留份数规范化）', () => {
  it('0 被抬到下限 —— 这正是「删光所有备份」的入口', () => {
    expect(normalizeKeepCount(0)).toBe(MIN_BACKUP_KEEP);
    expect(normalizeKeepCount(0, 10)).toBe(MIN_BACKUP_KEEP);
  });

  it('负数同样被抬到下限', () => {
    expect(normalizeKeepCount(-5, 10)).toBe(MIN_BACKUP_KEEP);
    expect(normalizeKeepCount(-1)).toBe(MIN_BACKUP_KEEP);
  });

  it('NaN / Infinity / null / 非数字字符串 回退到 fallback', () => {
    expect(normalizeKeepCount(Number.NaN, 10)).toBe(10);
    expect(normalizeKeepCount(Number.POSITIVE_INFINITY, 10)).toBe(10);
    expect(normalizeKeepCount(Number.NEGATIVE_INFINITY, 10)).toBe(10);
    expect(normalizeKeepCount(null, 10)).toBe(10);
    expect(normalizeKeepCount('5', 10)).toBe(10);
    expect(normalizeKeepCount(undefined, 10)).toBe(10);
  });

  it('非法输入且无 fallback 时仍保底 1 份（失败方向必须朝「留得更多」）', () => {
    expect(normalizeKeepCount(Number.NaN)).toBe(MIN_BACKUP_KEEP);
    expect(normalizeKeepCount(undefined)).toBe(MIN_BACKUP_KEEP);
  });

  it('正常值原样保留，小数向下取整', () => {
    expect(normalizeKeepCount(10)).toBe(10);
    expect(normalizeKeepCount(1)).toBe(1);
    expect(normalizeKeepCount(7.9)).toBe(7);
  });
});

describe('LocalBackupPruner（真实文件系统）', () => {
  let root: string;

  beforeEach(() => {
    root = path.join(os.tmpdir(), `zhshield-prune-${crypto.randomUUID()}`);
    fsSync.mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    fsSync.rmSync(root, { recursive: true, force: true });
  });

  /** 造 n 个快照目录，按 **新→旧** 返回（与 listBackups() 的约定一致） */
  async function makeSnapshots(n: number): Promise<string[]> {
    const dirs: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const name = `2026-09-${String(10 + i).padStart(2, '0')}T00-00-00-000Z`;
      const full = path.join(root, name);
      await fs.mkdir(full, { recursive: true });
      await fs.writeFile(path.join(full, 'payload.txt'), `snapshot ${i}`, 'utf-8');
      dirs.push(full);
    }
    return dirs.reverse();
  }

  it('maxBackups=0 时仍保留最新 1 份（修复前会删光全部）', async () => {
    const dirs = await makeSnapshots(3);
    const outcome = await new LocalBackupPruner().pruneOldBackups(dirs, 0);

    expect(outcome.removed.length).toBe(2);
    expect(outcome.failed).toEqual([]);
    expect(fsSync.existsSync(dirs[0])).toBe(true);
    expect(fsSync.existsSync(dirs[1])).toBe(false);
    expect(fsSync.existsSync(dirs[2])).toBe(false);
  });

  it('maxBackups 为 NaN 时同样不会删光', async () => {
    const dirs = await makeSnapshots(3);
    await new LocalBackupPruner().pruneOldBackups(dirs, Number.NaN);

    expect(fsSync.existsSync(dirs[0])).toBe(true);
    expect(fsSync.existsSync(dirs[2])).toBe(false);
  });

  it('正常轮换：只保留最新 N 份', async () => {
    const dirs = await makeSnapshots(5);
    const outcome = await new LocalBackupPruner().pruneOldBackups(dirs, 2);

    expect(outcome.removed).toEqual([dirs[2], dirs[3], dirs[4]]);
    expect(fsSync.existsSync(dirs[0])).toBe(true);
    expect(fsSync.existsSync(dirs[1])).toBe(true);
    expect(fsSync.existsSync(dirs[2])).toBe(false);
    expect(fsSync.existsSync(dirs[4])).toBe(false);
  });

  it('份数未超限时不动任何文件', async () => {
    const dirs = await makeSnapshots(2);
    const outcome = await new LocalBackupPruner().pruneOldBackups(dirs, 10);

    expect(outcome).toEqual({ removed: [], failed: [] });
    expect(fsSync.existsSync(dirs[0])).toBe(true);
    expect(fsSync.existsSync(dirs[1])).toBe(true);
  });

  it('空列表是安全输入', async () => {
    const outcome = await new LocalBackupPruner().pruneOldBackups([], 0);
    expect(outcome).toEqual({ removed: [], failed: [] });
  });
});

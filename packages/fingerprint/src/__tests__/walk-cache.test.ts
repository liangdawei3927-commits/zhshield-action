// walk-cache 测试：单飞记忆化 + 持久缓存 + fail-open 回退。
// 缓存目录用 ZHSHIELD_PERF_CACHE_DIR 指向临时目录，避免污染真实家目录。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkFiles } from '../fs-utils';
import { resetWalkCache } from '../walk-cache';
import { makeTempProject, cleanupTempProject } from './helpers';

let cacheDir: string;

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-walk-cache-'));
  process.env.ZHSHIELD_PERF_CACHE_DIR = cacheDir;
  resetWalkCache();
});

afterEach(() => {
  delete process.env.ZHSHIELD_PERF_CACHE_DIR;
  resetWalkCache();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('walkFiles 增量缓存', () => {
  it('GIVEN 未变化树 WHEN 连续两次 walkFiles THEN 第二次不重走（单飞记忆化）', () => {
    const root = makeTempProject({
      'a.txt': 'a',
      'src/b.ts': 'b',
      'src/nested/c.js': 'c',
    });
    const renamed = `${root}-renamed`;
    try {
      const first = walkFiles(root);
      expect(first).toEqual(['a.txt', 'src/b.ts', 'src/nested/c.js']);

      // 把根目录移走：若第二次仍重走，readdirSync 会因目录不存在而返回空列表；
      // 若命中进程内记忆化（单飞），则直接返回缓存列表，不触碰文件系统。
      fs.renameSync(root, renamed);

      const second = walkFiles(root);
      expect(second).toEqual(first);
    } finally {
      if (fs.existsSync(renamed)) cleanupTempProject(renamed);
      if (fs.existsSync(root)) cleanupTempProject(root);
    }
  });

  it('GIVEN 新增文件 WHEN 清空记忆化后再次 walkFiles THEN 返回含新文件的列表（结构变化触发重建）', () => {
    const root = makeTempProject({
      'a.txt': 'a',
      'b.txt': 'b',
    });
    try {
      const before = walkFiles(root);
      expect(before).toEqual(['a.txt', 'b.txt']);

      // 绕过进程内记忆化，走持久缓存校验路径
      resetWalkCache();
      fs.writeFileSync(path.join(root, 'c.txt'), 'c');

      const after = walkFiles(root);
      expect(after).toEqual(['a.txt', 'b.txt', 'c.txt']);
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 仅内容变化（同名）WHEN 清空记忆化后再次 walkFiles THEN 文件列表不变（内容不影响列表）', () => {
    const root = makeTempProject({
      'a.txt': 'old',
      'b.txt': 'b',
    });
    try {
      const before = walkFiles(root);
      expect(before).toEqual(['a.txt', 'b.txt']);

      resetWalkCache();
      fs.writeFileSync(path.join(root, 'a.txt'), 'new-content');

      const after = walkFiles(root);
      expect(after).toEqual(['a.txt', 'b.txt']);
    } finally {
      cleanupTempProject(root);
    }
  });

  it('GIVEN 缓存目录不可写 WHEN walkFiles THEN 静默回退全量遍历（fail-open）', () => {
    // 让缓存目录的父路径是一个文件 → mkdirSync 失败 → 持久缓存禁用
    const blocker = path.join(os.tmpdir(), `zh-walk-blocker-${Date.now()}`);
    fs.writeFileSync(blocker, 'not a dir');
    process.env.ZHSHIELD_PERF_CACHE_DIR = path.join(blocker, 'sub');
    resetWalkCache();

    const root = makeTempProject({
      'x.txt': 'x',
      'dir/y.txt': 'y',
    });
    try {
      expect(() => walkFiles(root)).not.toThrow();
      expect(walkFiles(root)).toEqual(['dir/y.txt', 'x.txt']);
    } finally {
      cleanupTempProject(root);
      fs.rmSync(blocker, { force: true });
    }
  });
});

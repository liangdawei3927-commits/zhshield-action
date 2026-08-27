/**
 * 回归测试：@zh/shared 的 safeJoin / safeResolve 在 dependency 包中的行为。
 *
 * 背景：dependency 包内所有 path.join / path.resolve 调用点已替换为
 * safeJoin / safeResolve（见安全巡检报告 2.1 Path Traversal）。
 * 本测试锁定替换后的行为契约：
 * - 界内输入：safeJoin / safeResolve 与 path.join / path.resolve 输出完全一致（行为保持）
 * - 越界输入（'..' 逃逸）：safeJoin 抛出 PathTraversalError（预期的新行为）
 */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { safeJoin, safeResolve, PathTraversalError } from '@zh/shared';

describe('safeJoin / safeResolve path-traversal regression', () => {
  const dir = path.resolve('/tmp', 'zh-safe-path-base');

  it('safeJoin 与 path.join 对界内输入输出一致', () => {
    expect(safeJoin(dir, 'a', 'b.ts')).toBe(path.join(dir, 'a', 'b.ts'));
    expect(safeJoin(dir, 'sub', 'nested', 'file.js')).toBe(
      path.join(dir, 'sub', 'nested', 'file.js'),
    );
  });

  it('safeResolve 与 path.resolve 对界内输入输出一致', () => {
    expect(safeResolve(dir, 'sub/x.ts')).toBe(path.resolve(dir, 'sub/x.ts'));
    expect(safeResolve(dir, 'a/b/c.ts')).toBe(path.resolve(dir, 'a/b/c.ts'));
  });

  it('safeJoin 对越界（.. 逃逸）输入抛出 PathTraversalError', () => {
    expect(() => safeJoin(dir, '..', 'x')).toThrow(PathTraversalError);
    expect(() => safeJoin(dir, 'a', '..', '..', 'x')).toThrow(PathTraversalError);
  });
});

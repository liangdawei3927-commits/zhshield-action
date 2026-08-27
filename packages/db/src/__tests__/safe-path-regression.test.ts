import * as path from 'path';
import { safeJoin, safeResolve, PathTraversalError } from '@zh/shared';

describe('safeJoin / safeResolve path-traversal regression', () => {
  const dir = path.resolve('/tmp', 'zh-safe-path-base-db');

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

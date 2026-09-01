import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  safeJoin,
  safeJoinReal,
  safeResolve,
  safeResolveReal,
  PathTraversalError,
} from '@zh/shared';

describe('safeJoin / safeResolve path-traversal regression', () => {
  const dir = path.resolve('/tmp', 'zh-safe-path-base-performance');

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

describe('safeResolveReal / safeJoinReal 词法与符号链接逃逸', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-safe-resolve-real-'));

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('safeResolveReal 与 path.resolve 对界内输入输出一致', () => {
    expect(safeResolveReal(base, 'sub/x.ts')).toBe(path.resolve(base, 'sub/x.ts'));
    expect(safeResolveReal(base, 'a/b/c.ts')).toBe(path.resolve(base, 'a/b/c.ts'));
  });

  it('safeResolveReal 对越界（.. 逃逸 / 绝对路径）输入抛出 PathTraversalError', () => {
    expect(() => safeResolveReal(base, '../x')).toThrow(PathTraversalError);
    expect(() => safeResolveReal(base, '/etc/passwd')).toThrow(PathTraversalError);
  });

  it('safeResolveReal 对指向 base 外的符号链接抛出 PathTraversalError', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-safe-outside-'));
    try {
      fs.symlinkSync(outside, path.join(base, 'link'));
      expect(() => safeResolveReal(base, 'link/secret.txt')).toThrow(PathTraversalError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(path.join(base, 'link'), { force: true });
    }
  });

  it('safeJoinReal 对指向 base 外的符号链接抛出 PathTraversalError', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-safe-outside-'));
    try {
      fs.symlinkSync(outside, path.join(base, 'link'));
      expect(() => safeJoinReal(base, 'link', 'secret.txt')).toThrow(PathTraversalError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(path.join(base, 'link'), { force: true });
    }
  });
});

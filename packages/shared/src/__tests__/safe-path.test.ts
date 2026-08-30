import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { safeJoin, safeResolve, safeResolveReal, PathTraversalError } from '../security/safe-path';

describe('safeJoin', () => {
  it('baseline parity: safeJoin(a, b) === path.join(a, b) for in-bounds inputs', () => {
    expect(safeJoin('a', 'b')).toBe(path.join('a', 'b'));
    expect(safeJoin('/a', 'b')).toBe(path.join('/a', 'b'));
    expect(safeJoin('/a/b', 'c', 'd')).toBe(path.join('/a/b', 'c', 'd'));
    expect(safeJoin('/a', 'b', '..', 'c')).toBe(path.join('/a', 'b', '..', 'c'));
    expect(safeJoin('/a', '.')).toBe(path.join('/a', '.'));
    expect(safeJoin('/a')).toBe(path.join('/a'));
  });

  it('throws PathTraversalError when a segment escapes the base', () => {
    expect(() => safeJoin('/a', '..', 'x')).toThrow(PathTraversalError);
    expect(() => safeJoin('/a/b', '../../x')).toThrow(PathTraversalError);
  });

  it('allows the exact base path (does not throw)', () => {
    expect(() => safeJoin('/a', '.')).not.toThrow();
    expect(() => safeJoin('/a', '')).not.toThrow();
  });
});

describe('safeResolve', () => {
  it('parity: safeResolve(base, rel) === path.resolve(base, rel) for in-bounds inputs', () => {
    expect(safeResolve('/a', 'b')).toBe(path.resolve('/a', 'b'));
    expect(safeResolve('/a/b', 'c/d')).toBe(path.resolve('/a/b', 'c/d'));
    expect(safeResolve('/a', 'b/../c')).toBe(path.resolve('/a', 'b/../c'));
    expect(safeResolve('a', 'b')).toBe(path.resolve('a', 'b'));
    expect(safeResolve('/a', '.')).toBe(path.resolve('/a', '.'));
  });

  it('throws PathTraversalError when an absolute target escapes the base', () => {
    expect(() => safeResolve('/a', '/etc/passwd')).toThrow(PathTraversalError);
  });

  it('throws PathTraversalError when a relative target escapes the base', () => {
    expect(() => safeResolve('/a', '../../etc/passwd')).toThrow(PathTraversalError);
  });

  it('allows the exact base path (does not throw)', () => {
    expect(() => safeResolve('/a', '.')).not.toThrow();
    expect(() => safeResolve('/a', '')).not.toThrow();
  });
});

describe('safeResolveReal', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-safe-resolve-real-'));

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('parity: safeResolveReal(base, rel) === path.resolve(base, rel) for in-bounds inputs', () => {
    expect(safeResolveReal(base, 'b')).toBe(path.resolve(base, 'b'));
    expect(safeResolveReal(base, 'c/d')).toBe(path.resolve(base, 'c/d'));
    expect(safeResolveReal(base, 'b/../c')).toBe(path.resolve(base, 'b/../c'));
    expect(safeResolveReal(base, '.')).toBe(path.resolve(base, '.'));
  });

  it('throws PathTraversalError when an absolute target escapes the base', () => {
    expect(() => safeResolveReal(base, '/etc/passwd')).toThrow(PathTraversalError);
  });

  it('throws PathTraversalError when a relative target escapes the base', () => {
    expect(() => safeResolveReal(base, '../../etc/passwd')).toThrow(PathTraversalError);
  });

  it('throws PathTraversalError when a symlink inside base points outside', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-safe-outside-'));
    try {
      fs.symlinkSync(outside, path.join(base, 'link'));
      expect(() => safeResolveReal(base, 'link/secret.txt')).toThrow(PathTraversalError);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(path.join(base, 'link'), { force: true });
    }
  });
});

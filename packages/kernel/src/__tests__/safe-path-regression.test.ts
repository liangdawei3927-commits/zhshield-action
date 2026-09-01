import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import { safeJoin, safeResolve, PathTraversalError } from '@zh/shared';

describe('safeJoin / safeResolve regression (kernel)', () => {
  const dir = path.join(os.tmpdir(), 'zh-safe-path-kernel');

  it('safeJoin(dir, "a", "b.ts") equals path.join(dir, "a", "b.ts")', () => {
    expect(safeJoin(dir, 'a', 'b.ts')).toBe(path.join(dir, 'a', 'b.ts'));
  });

  it('safeResolve(dir, "sub/x.ts") equals path.resolve(dir, "sub/x.ts")', () => {
    expect(safeResolve(dir, 'sub/x.ts')).toBe(path.resolve(dir, 'sub/x.ts'));
  });

  it('safeJoin(dir, "..", "x") throws PathTraversalError', () => {
    expect(() => safeJoin(dir, '..', 'x')).toThrow(PathTraversalError);
  });
});

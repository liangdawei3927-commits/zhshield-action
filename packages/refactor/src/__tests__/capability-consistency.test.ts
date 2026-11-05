import { describe, it, expect } from 'vitest';
import { CAPABILITY_REGISTRY } from '@zh/shared';
import { listAutoFixableRules } from '../auto-fix';

/**
 * 闭环不变量（代码审查报告3 P1-1 的机制化兜底）。
 *
 * 能力注册表里 `refactor.auto-fix` 的 `implementedBy` 必须与 `auto-fix.ts` 的
 * `FIX_GENERATORS` 实际覆盖的规则集合**严格一致**。
 *
 * 一致 ≠ 各自为真：任一侧新增/删除而另一侧未同步，都会在这里变红，把
 * "某项被声明为可自动修复、实则没有生成器（或反之）"的漂移挡在合并前 ——
 * 这类漂移正是 P1-1（shotgun-surgery 声称可修但生成器只会产出未引用常量/首次 ENOENT）的根因。
 */
describe('自动修复能力与能力注册表一致（防「宣称 vs 实现」漂移）', () => {
  const cap = CAPABILITY_REGISTRY.find((c) => c.id === 'refactor.auto-fix');

  it('注册表存在 refactor.auto-fix 且状态为 implemented', () => {
    expect(cap).toBeDefined();
    expect(cap?.status).toBe('implemented');
  });

  it('implementedBy 与 FIX_GENERATORS 覆盖的规则集合严格相等', () => {
    const declared = [...(cap?.implementedBy ?? [])].sort();
    const actual = [...listAutoFixableRules()].sort();
    expect(actual, 'auto-fix.ts 的生成器规则与注册表声明不一致 —— 能力清单与实现漂移了').toEqual(
      declared,
    );
  });
});

import { describe, it, expect } from 'vitest';
import type { IssueSource } from '@zh/shared';

describe('IssueSource 扩展', () => {
  it('IssueSource 包含 performance（编译期校验）', () => {
    // satisfies 编译期校验：若 'performance' 不在 IssueSource 联合中则编译失败
    const source = 'performance' satisfies IssueSource;
    expect(source).toBe('performance');
  });

  it('既有成员仍有效', () => {
    const sources: IssueSource[] = [
      'guard',
      'inspect',
      'sentinel',
      'security',
      'refactor',
      'performance',
    ];
    expect(sources).toContain('performance');
  });
});

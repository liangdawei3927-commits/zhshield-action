import { describe, expect, it } from 'vitest';
import { buildTsPruneArgs } from '../adapters/ts-prune-adapter';
import type { ToolScanOptions } from '@zh/shared';

function options(config?: Record<string, unknown>): ToolScanOptions {
  return {
    projectPath: '/p',
    projectId: '/p',
    config: { enabled: true, ...(config ?? {}) } as ToolScanOptions['config'],
  };
}

describe('buildTsPruneArgs', () => {
  it('未声明 skip/ignore 时只传 -p（不带 --json：该开关会让文本解析器失效）', () => {
    expect(buildTsPruneArgs(options(), 'tsconfig.json')).toEqual(['-p', 'tsconfig.json']);
    expect(buildTsPruneArgs(options(), 'tsconfig.json')).not.toContain('--json');
  });

  it('声明 skip 时合并为单个 -s 正则（ts-prune 每次只接受一个 RegExp）', () => {
    const args = buildTsPruneArgs(options({ skip: ['(.*\\.module\\.ts)$', '(index\\.ts)$'] }), 't');
    expect(args[args.indexOf('-s') + 1]).toBe('((.*\\.module\\.ts)$|(index\\.ts)$)');
  });

  it('单个 skip 模式不额外包裹分组', () => {
    const args = buildTsPruneArgs(options({ skip: ['(index\\.ts)$'] }), 't');
    expect(args[args.indexOf('-s') + 1]).toBe('(index\\.ts)$');
  });

  it('ignore 走 -i，且非字符串元素被忽略（不让脏配置进命令行）', () => {
    const args = buildTsPruneArgs(
      options({ ignore: ['(node_modules|dist)/', 42, null] }),
      'tsconfig.json',
    );
    expect(args[args.indexOf('-i') + 1]).toBe('(node_modules|dist)/');
    expect(args).toEqual(['-p', 'tsconfig.json', '-i', '(node_modules|dist)/']);
  });
});

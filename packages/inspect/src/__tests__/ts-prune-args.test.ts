import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { buildTsPruneArgs } from '../adapters/ts-prune-adapter';
import { DEFAULT_TOOL_SCAN_TIMEOUT_MS } from '../adapters/tool-runner';
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

/**
 * 🔴 内外层超时必须一致（2026-10-25）。
 *
 * 内核 dispatch 早就把硬上限从 2 分钟提到 5 分钟（dispatch-shared 的注释原话：
 * 「2 分钟对大型 monorepo（20+ 包）不足，提至 5 分钟」），但各适配器内部的
 * `options.timeout || 60000` 没跟着改 —— 内层在 60s 先返回 status=error，
 * 外层那个 300s 护栏永远没有机会生效。
 *
 * 实测（本仓 1155 个 TS 源文件，8GB Intel Mac）：全仓 ts-prune 需 60–90s，正压在
 * 原 60s 默认值上 —— 同一条命令四次运行得到 available(59.9s) / error(60.3s) /
 * error(60.5s)，随机器负载漂移。表现为「工具执行失败」而不是「零检出」。
 */
describe('工具扫描默认超时 — 适配器不得早于外层护栏放弃', () => {
  it('默认超时为 5 分钟，不再退回 60s', () => {
    expect(DEFAULT_TOOL_SCAN_TIMEOUT_MS).toBe(300_000);
  });

  it('与内核 dispatch 的硬上限取值一致（改一边必须同步改另一边）', () => {
    const kernelSrc = readFileSync(
      path.resolve(process.cwd(), '../kernel/src/runner/dispatch-shared.ts'),
      'utf8',
    );
    const matched = kernelSrc.match(
      /export const DEFAULT_TOOL_SCAN_TIMEOUT_MS\s*=\s*([\d_]+)/,
    );
    expect(matched).not.toBeNull();
    const kernelValue = Number((matched as RegExpMatchArray)[1].replace(/_/g, ''));
    expect(kernelValue).toBe(DEFAULT_TOOL_SCAN_TIMEOUT_MS);
  });

  it('三个适配器不再写死 60s 默认值（防复制粘贴回退）', () => {
    for (const file of ['ts-prune-adapter.ts', 'jscpd-adapter.ts', 'depcheck-adapter.ts']) {
      const src = readFileSync(path.resolve(process.cwd(), 'src/adapters', file), 'utf8');
      expect(src, `${file} 仍在用 60s 默认超时`).not.toMatch(/\|\|\s*60_?000/);
    }
  });
});

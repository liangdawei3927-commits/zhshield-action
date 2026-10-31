import { describe, it, expect } from 'vitest';
import { isExcludedScanPath } from '../engine';

/**
 * 显式文件列表的口径必须与整目录扫描一致
 *
 * 缺陷（2026-11-01 实测）：`analyzeDirectory` 经 `collectTsFiles` 跳过 `__tests__/fixtures`，
 * 而 zhcheck 的 `--staged` 走 `analyzeFiles` 显式列表。于是 875 行的测试文件在全量门禁里
 * 从不计分，在暂存区门禁里却被报成 `introduced: oversized-file` —— 同一份代码两套结论。
 * 本文件锁定判定函数，保证「全量看不见的文件，暂存区也不计分」。
 */
describe('isExcludedScanPath', () => {
  it('测试与夹具目录内的文件不参与门禁计分（与整目录扫描同口径）', () => {
    expect(isExcludedScanPath('packages/x/src/__tests__/a.test.ts')).toBe(true);
    expect(isExcludedScanPath('packages/x/test/a.ts')).toBe(true);
    expect(isExcludedScanPath('packages/x/e2e/a.ts')).toBe(true);
    expect(isExcludedScanPath('packages/x/fixtures/a.ts')).toBe(true);
    expect(isExcludedScanPath('packages/x/src/__mocks__/a.ts')).toBe(true);
  });

  it('构建产物与隐藏目录同样排除（避免把 dist 里的副本当成新增坏味道）', () => {
    expect(isExcludedScanPath('packages/x/dist/a.js')).toBe(true);
    expect(isExcludedScanPath('packages/x/node_modules/@zh/y/a.ts')).toBe(true);
    expect(isExcludedScanPath('.zhshield/cache/a.ts')).toBe(true);
  });

  it('声明文件不参与扫描计分（整目录扫描的 isTsSourceFile 已排除 .d.ts）', () => {
    expect(isExcludedScanPath('packages/x/src/types/electron.d.ts')).toBe(true);
    expect(isExcludedScanPath('packages/x/src/types/electron.ts')).toBe(false);
  });

  it('产品源码正常计分，不受相对路径前缀影响', () => {
    expect(isExcludedScanPath('packages/x/src/a.ts')).toBe(false);
    expect(isExcludedScanPath('./packages/x/src/a.ts')).toBe(false);
    expect(isExcludedScanPath('/abs/packages/x/src/a.ts')).toBe(false);
  });

  it('目录名按整段匹配，前缀相同但语义无关的目录不误伤', () => {
    expect(isExcludedScanPath('packages/x/src/attestation/a.ts')).toBe(false);
    expect(isExcludedScanPath('packages/x/src/testing-helpers/a.ts')).toBe(false);
  });
});

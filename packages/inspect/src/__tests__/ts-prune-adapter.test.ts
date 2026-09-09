import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

/**
 * os.homedir 为只读 getter（不可 spyOn）——整体 mock 以隔离 ~/.zhshield 路径，
 * 便于在测试中替换为临时目录（与 tool-bin.test.ts 同模式）。
 */
vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  return { ...mod, homedir: vi.fn(() => tmpdir()) };
});

import { TsPruneAdapter } from '../adapters/ts-prune-adapter';

describe('TsPruneAdapter.isAvailable — 存在性检查（不执行 --version）', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'ts-prune-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const writeLocalBin = (mode: number): string => {
    const bin = path.join(tempDir, 'node_modules', '.bin', 'ts-prune');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\n');
    chmodSync(bin, mode);
    return bin;
  };

  it('本地 bin 存在且可执行时返回 true', async () => {
    writeLocalBin(0o755);
    const adapter = new TsPruneAdapter(tempDir);
    await expect(adapter.isAvailable()).resolves.toBe(true);
  });

  it('本地 bin 存在但不可执行时返回 false', async () => {
    writeLocalBin(0o644);
    const adapter = new TsPruneAdapter(tempDir);
    await expect(adapter.isAvailable()).resolves.toBe(false);
  });

  it('无本地 bin 且 PATH 中无该命令时返回 false（不触发全量扫描）', async () => {
    const emptyPath = path.join(tempDir, 'empty-path');
    mkdirSync(emptyPath, { recursive: true });
    const origPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      const adapter = new TsPruneAdapter(tempDir);
      await expect(adapter.isAvailable()).resolves.toBe(false);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
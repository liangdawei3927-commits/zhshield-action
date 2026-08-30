import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import * as os from 'node:os';

/**
 * os.homedir 为只读 getter（不可 spyOn）——整体 mock 以隔离 ~/.zhshield 路径，
 * 便于在测试中替换为临时目录。
 */
vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  return { ...mod, homedir: vi.fn(() => tmpdir()) };
});

import { findLocalToolBin, getZhshieldToolBinDir, findZhshieldToolBin } from '../adapters/tool-bin';

describe('findLocalToolBin — 本地 node_modules/.bin 工具解析', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'tool-bin-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('当前目录 node_modules/.bin 命中时返回绝对路径', () => {
    const bin = path.join(tempDir, 'node_modules', '.bin', 'eslint');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\n');
    expect(findLocalToolBin('eslint', tempDir)).toBe(bin);
  });

  it('一层子目录命中（嵌套仓库场景，如外层 guard 目录下的 monorepo）', () => {
    const bin = path.join(tempDir, 'nested-repo', 'node_modules', '.bin', 'tsc');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\n');
    expect(findLocalToolBin('tsc', tempDir)).toBe(bin);
  });

  it('父目录命中（从深层子目录向上回溯）', () => {
    const bin = path.join(tempDir, 'node_modules', '.bin', 'prettier');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\n');
    const deep = path.join(tempDir, 'src', 'deep', 'dir');
    mkdirSync(deep, { recursive: true });
    expect(findLocalToolBin('prettier', deep)).toBe(bin);
  });

  it('不存在时返回 null', () => {
    expect(findLocalToolBin('semgrep', tempDir)).toBeNull();
  });

  it('目录不可读时安全返回 null 而非抛错', () => {
    const missing = path.join(tempDir, 'does-not-exist');
    expect(existsSync(missing)).toBe(false);
    expect(() => findLocalToolBin('eslint', missing)).not.toThrow();
    expect(findLocalToolBin('eslint', missing)).toBeNull();
  });
});

describe('findZhshieldToolBin — ~/.zhshield/bin 共享工具目录解析', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), 'zhshield-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('getZhshieldToolBinDir 指向 ~/.zhshield/bin', () => {
    expect(getZhshieldToolBinDir()).toBe(path.join(fakeHome, '.zhshield', 'bin'));
  });

  it('共享目录中存在工具时返回绝对路径', () => {
    const bin = path.join(fakeHome, '.zhshield', 'bin', 'semgrep');
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\n', { mode: 0o755 });
    expect(findZhshieldToolBin('semgrep')).toBe(bin);
  });

  it('共享目录不存在时返回 null 而非抛错', () => {
    expect(findZhshieldToolBin('gitleaks')).toBeNull();
  });

  it('目录存在但工具缺失时返回 null', () => {
    mkdirSync(path.join(fakeHome, '.zhshield', 'bin'), { recursive: true });
    expect(findZhshieldToolBin('trivy')).toBeNull();
  });
});

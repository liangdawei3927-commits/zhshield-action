import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { findLocalToolBin } from '../adapters/tool-bin';

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

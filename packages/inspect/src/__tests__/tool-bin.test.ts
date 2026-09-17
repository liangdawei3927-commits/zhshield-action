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

import {
  findLocalToolBin,
  getZhshieldToolBinDir,
  findZhshieldToolBin,
  resolveToolCommand,
  resolveToolCommandDetailed,
} from '../adapters/tool-bin';

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

/**
 * P1（复查5）：解析顺序必须让"版本可控"的来源优先于"碰巧存在"的环境变量。
 * 原顺序是 项目本地 → PATH 全局 → 共享目录，导致项目没装本地依赖时会采用
 * PATH 上任意版本（实证：depcruise 全局 18.1.1 读不出 TS 依赖图，modules=0）。
 */
describe('resolveToolCommandDetailed — 来源顺序与来源标记', () => {
  let fakeHome: string;
  let projectDir: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(path.join(tmpdir(), 'zhshield-home-'));
    projectDir = mkdtempSync(path.join(tmpdir(), 'zhshield-proj-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('项目本地存在时 origin=project-local（最高优先）', async () => {
    const localBin = path.join(projectDir, 'node_modules', '.bin', 'eslint');
    mkdirSync(path.dirname(localBin), { recursive: true });
    writeFileSync(localBin, '#!/usr/bin/env node\n');
    const sharedBin = path.join(fakeHome, '.zhshield', 'bin', 'eslint');
    mkdirSync(path.dirname(sharedBin), { recursive: true });
    writeFileSync(sharedBin, '#!/usr/bin/env node\n');

    const r = await resolveToolCommandDetailed('eslint', projectDir);
    expect(r).toEqual({ command: localBin, origin: 'project-local' });
  });

  it('项目本地缺失时 origin=shared —— 共享目录优先于 PATH 全局（本轮修复点）', async () => {
    const sharedBin = path.join(fakeHome, '.zhshield', 'bin', 'definitely-not-on-path-tool');
    mkdirSync(path.dirname(sharedBin), { recursive: true });
    writeFileSync(sharedBin, '#!/usr/bin/env node\n');

    const r = await resolveToolCommandDetailed('definitely-not-on-path-tool', projectDir);
    expect(r).toEqual({ command: sharedBin, origin: 'shared' });
  });

  it('本地与共享均缺失时回退 PATH 全局并标记 origin=path', async () => {
    // 用一个必然存在于 PATH 的命令做探针，避免依赖具体工具是否安装
    const r = await resolveToolCommandDetailed('node', projectDir);
    expect(r.origin).toBe('path');
    expect(r.command).toBe('node');
  });

  it('三处均无该工具时 origin=unresolved（调用方据此判 missing）', async () => {
    const r = await resolveToolCommandDetailed('zhshield-no-such-tool-xyz', projectDir);
    expect(r).toEqual({ command: 'zhshield-no-such-tool-xyz', origin: 'unresolved' });
  });

  it('probeTimeoutMs 可覆盖 PATH 探测超时（桌面端工具面板批量探测需控制总耗时）', async () => {
    const r = await resolveToolCommandDetailed('node', projectDir, { probeTimeoutMs: 2_000 });
    expect(r).toEqual({ command: 'node', origin: 'path' });
  });

  it('resolveToolCommand 兼容薄封装仍返回命令字符串', async () => {
    const command = await resolveToolCommand('node', projectDir);
    expect(command).toBe('node');
  });
});

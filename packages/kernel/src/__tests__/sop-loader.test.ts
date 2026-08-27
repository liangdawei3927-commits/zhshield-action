import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 注入式 ENOENT：仅当路径登记在 enoentPaths 时拦截 readFile，其余全部透传真实 fs。
// 用于确定性模拟「扫描与读取之间文件消失」的预期缺失场景。
const { enoentPaths } = vi.hoisted(() => ({ enoentPaths: new Set<string>() }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realReadFile = actual.promises.readFile.bind(actual.promises);
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: async (...args: Parameters<typeof realReadFile>) => {
        const filePath = String(args[0]);
        if (enoentPaths.has(filePath)) {
          const err = new Error(
            `ENOENT: no such file or directory, open '${filePath}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          err.errno = -2;
          err.path = filePath;
          throw err;
        }
        return realReadFile(...args);
      },
    },
  };
});

import { SopLoader } from '../sop/_meta/sop-loader';
import { SopRegistry } from '../sop/_meta/sop-registry';

const VALID_RULE_YAML = (id: string, name: string): string =>
  `metadata:\n  id: ${id}\n  name: ${name}\n`;

function writeRuleFile(root: string, relPath: string, content: string): string {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return fullPath;
}

function makeRulesRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sop-loader-test-'));
}

describe('SopLoader 异常控制流（not-found 与真实失败的区分）', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    enoentPaths.clear();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function trackDir(): string {
    const dir = makeRulesRoot();
    tempDirs.push(dir);
    return dir;
  }

  it('正常目录加载：返回规则数并全部注册（基线）', async () => {
    const root = trackDir();
    writeRuleFile(root, 'guard/scan/a.yml', VALID_RULE_YAML('t.a', 'A'));
    writeRuleFile(root, 'guard/scan/b.yml', VALID_RULE_YAML('t.b', 'B'));

    const registry = new SopRegistry();
    const loaded = await new SopLoader(registry, { rulesDir: root }).loadFromFileSystem();

    expect(loaded).toBe(2);
    expect(registry.count()).toBe(2);
    expect(registry.get('t.a')?.name).toBe('A');
  });

  // ─── 类别一：file/rule not found（预期、可恢复 → warn + 空结果，不抛错）───
  it('规则目录不存在：warn 并返回 0，不抛错也不误报 error', async () => {
    const registry = new SopRegistry();
    const loaded = await new SopLoader(registry, {
      rulesDir: path.join(os.tmpdir(), 'sop-loader-nope-does-not-exist'),
    }).loadFromFileSystem();

    expect(loaded).toBe(0);
    expect(registry.count()).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('规则文件在读取时消失（ENOENT）：按预期缺失 warn 跳过，其余文件照常加载', async () => {
    const root = trackDir();
    const ghost = writeRuleFile(root, 'guard/scan/ghost.yml', VALID_RULE_YAML('t.ghost', 'G'));
    writeRuleFile(root, 'guard/scan/real.yml', VALID_RULE_YAML('t.real', 'R'));
    enoentPaths.add(ghost);

    const registry = new SopRegistry();
    const loaded = await new SopLoader(registry, { rulesDir: root }).loadFromFileSystem();

    expect(loaded).toBe(1);
    expect(registry.get('t.real')).toBeDefined();
    expect(registry.get('t.ghost')).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('ghost.yml');
  });

  // ─── 类别二：真实加载失败（记录 error 或向上传播，绝不静默吞成空状态）───
  it('单个文件 YAML 损坏：console.error 记录该文件，其余文件照常加载', async () => {
    const root = trackDir();
    writeRuleFile(root, 'guard/scan/broken.yml', 'foo: [unclosed');
    writeRuleFile(root, 'guard/scan/good.yml', VALID_RULE_YAML('t.good', 'G'));

    const registry = new SopRegistry();
    const loaded = await new SopLoader(registry, { rulesDir: root }).loadFromFileSystem();

    expect(loaded).toBe(1);
    expect(registry.get('t.good')).toBeDefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // 日志注入防护：格式串为常量模板，文件路径作为净化后的参数传入
    expect(String(errorSpy.mock.calls[0]?.[0])).toBe('[SopLoader] Failed to parse rule file: %s');
    expect(String(errorSpy.mock.calls[0]?.[1])).toContain('broken.yml');
  });

  it('YAML 顶层为标量：warn 跳过而非静默吞掉', async () => {
    const root = trackDir();
    writeRuleFile(root, 'guard/scan/scalar.yml', 'just-a-plain-string');
    writeRuleFile(root, 'guard/scan/good.yml', VALID_RULE_YAML('t.good', 'G'));

    const registry = new SopRegistry();
    const loaded = await new SopLoader(registry, { rulesDir: root }).loadFromFileSystem();

    expect(loaded).toBe(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('scalar.yml');
  });

  it('rulesDir 指向普通文件：readdir 失败向上传播，不被吞成空结果', async () => {
    const root = trackDir();
    const filePath = path.join(root, 'plain-file.txt');
    fs.writeFileSync(filePath, 'not a directory', 'utf-8');

    const registry = new SopRegistry();
    await expect(
      new SopLoader(registry, { rulesDir: filePath }).loadFromFileSystem(),
    ).rejects.toThrow();
    expect(registry.count()).toBe(0);
  });

  // ─── 异常不再作为控制流：has()/update()/register() 显式分支 ───
  it('已存在同 id 规则时走 update 分支：无异常、count 不变、内容更新', async () => {
    const root = trackDir();
    writeRuleFile(root, 'guard/scan/dup.yml', VALID_RULE_YAML('t.dup', 'Updated Name'));

    const registry = new SopRegistry();
    registry.register({
      id: 't.dup',
      name: 'Original',
      domain: 'guard',
      action: 'scan',
      source: 'official',
      description: '',
      status: 'draft',
      executionMode: 'sync',
      severity: 'low',
      applicableEngines: ['guard'],
      content: {},
      tags: [],
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const loaded = await new SopLoader(registry, { rulesDir: root }).loadFromDirectory(root);

    expect(loaded).toBe(1);
    expect(registry.count()).toBe(1);
    expect(registry.get('t.dup')?.name).toBe('Updated Name');
  });

  it('loadFromKnowledgeBase 混合新增与已存在：新规则注册、已有规则更新', async () => {
    const registry = new SopRegistry();
    registry.register({
      id: 't.exists',
      name: 'Old',
      domain: 'guard',
      action: 'scan',
      source: 'official',
      description: '',
      status: 'draft',
      executionMode: 'sync',
      severity: 'low',
      applicableEngines: ['guard'],
      content: {},
      tags: [],
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const incoming = [
      {
        id: 't.exists',
        name: 'New',
        domain: 'guard' as const,
        action: 'scan' as const,
        source: 'official' as const,
        description: '',
        status: 'active' as const,
        executionMode: 'sync' as const,
        severity: 'high' as const,
        applicableEngines: ['guard'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 't.fresh',
        name: 'Fresh',
        domain: 'guard' as const,
        action: 'scan' as const,
        source: 'official' as const,
        description: '',
        status: 'active' as const,
        executionMode: 'sync' as const,
        severity: 'medium' as const,
        applicableEngines: ['guard'],
        content: {},
        tags: [],
        falsePositiveCount: 0,
        truePositiveCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    await new SopLoader(registry).loadFromKnowledgeBase(incoming);

    expect(registry.count()).toBe(2);
    expect(registry.get('t.exists')?.name).toBe('New');
    expect(registry.get('t.fresh')).toBeDefined();
  });

  it('register 的非重复异常不再被吞成 update：真实失败向上传播', async () => {
    const root = trackDir();
    writeRuleFile(root, 'guard/scan/x.yml', VALID_RULE_YAML('t.x', 'X'));

    const spurious = new Error('register exploded');
    const registry = {
      has: () => false,
      register: () => {
        throw spurious;
      },
      update: vi.fn(),
      loadAll: vi.fn(),
    } as unknown as SopRegistry;

    await expect(
      new SopLoader(registry, { rulesDir: root }).loadFromDirectory(root),
    ).rejects.toThrow('register exploded');
    expect(vi.mocked(registry.update)).not.toHaveBeenCalled();
  });
});

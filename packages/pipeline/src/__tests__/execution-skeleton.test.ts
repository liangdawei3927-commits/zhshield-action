import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFileIndex } from '../execution/file-index';
import { ToolExecutor } from '../execution/tool-executor';
import { routeFindings, type RoutableFinding } from '../execution/router';

/** 造一棵最小仓库树：源码 / 清单 / 锁文件 / 构建产物 / node_modules */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'zh-fileindex-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.py'), 'print(1)\n');
  writeFileSync(join(root, 'package.json'), '{}\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
  writeFileSync(join(root, 'dist', 'bundle.js'), 'var x=1;\n');
  return root;
}

describe('FileIndex（执行层第一层）', () => {
  it('Given 含 node_modules 与 dist 的仓库，When 建索引，Then 只收源码/清单/锁文件，构建产物只记目录', () => {
    const root = makeFixture();
    try {
      const index = buildFileIndex(root);

      expect(index.source).toEqual(['src/a.ts', 'src/b.py']);
      expect(index.manifest).toEqual(['package.json']);
      expect(index.lockfile).toEqual(['pnpm-lock.yaml']);
      expect(index.buildOutputDirs).toEqual(['dist']);
      // 被跳过的两类目录内容不得出现在任何列表
      expect(index.targets.some((t) => t.path.includes('node_modules'))).toBe(false);
      expect(index.targets.some((t) => t.path.includes('dist/bundle.js'))).toBe(false);
      expect(index.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Given maxFiles 小于实际文件数，When 建索引，Then truncated=true（不静默截断）', () => {
    const root = makeFixture();
    try {
      const index = buildFileIndex(root, { maxFiles: 2 });
      expect(index.truncated).toBe(true);
      expect(index.source.length + index.manifest.length + index.lockfile.length).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ToolExecutor（执行层第二层，A12）', () => {
  it('Given 同 (tool, targets, args) 被两个域各请求一次，When 执行，Then 只起一个进程', async () => {
    const executor = new ToolExecutor();
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ['finding'];
    };
    const invocation = {
      tool: 'semgrep' as const,
      targets: ['src/a.ts', 'src/b.ts'],
      args: ['--json'],
    };

    const first = await executor.executeOnce(invocation, run);
    const second = await executor.executeOnce(
      // targets 顺序不同也必须命中同一 key
      { ...invocation, targets: ['src/b.ts', 'src/a.ts'] },
      run,
    );

    expect(runs).toBe(1);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(executor.invocationCount('semgrep')).toBe(1);
  });

  it('Given 失败结果，When 同一次运行内再次请求，Then 复用失败而不重跑（避免进程次数翻倍）', async () => {
    const executor = new ToolExecutor();
    let runs = 0;
    const run = async (): Promise<string> => {
      runs += 1;
      throw new Error('boom');
    };
    const invocation = { tool: 'trivy' as const, targets: ['pnpm-lock.yaml'] };

    await expect(executor.executeOnce(invocation, run)).rejects.toThrow('boom');
    await expect(executor.executeOnce(invocation, run)).rejects.toThrow('boom');
    expect(runs).toBe(1);
  });

  it('Given reset，When 新一次运行，Then 计数与缓存清空', async () => {
    const executor = new ToolExecutor();
    const invocation = { tool: 'eslint' as const, targets: ['src/a.ts'] };
    await executor.executeOnce(invocation, async () => 'ok');
    executor.reset();
    expect(executor.invocationCount()).toBe(0);
    const again = await executor.executeOnce(invocation, async () => 'ok');
    expect(again.reused).toBe(false);
  });
});

describe('Router（执行层第三层，C1/C2）', () => {
  it('Given 跨域 findings，When 路由，Then 每条只投给唯一 owner 并记录 distribution', () => {
    const findings: RoutableFinding[] = [
      { ruleId: 'inspect.scan.official.duplication', fingerprint: 'dup:1' },
      { ruleId: 'security.scan.official.secrets', fingerprint: 'sec:1' },
      { ruleId: 'deps.scan.official.cve', fingerprint: 'cve:1' },
    ];

    const result = routeFindings(findings);

    expect(result.byOwner.refactor).toHaveLength(1);
    expect(result.byOwner.security).toHaveLength(1);
    expect(result.byOwner.deps).toHaveLength(1);
    expect(result.byOwner.inspect).toBeUndefined();
    expect(result.distribution).toEqual([
      { ruleId: 'inspect.scan.official.duplication', owner: 'refactor', fingerprint: 'dup:1' },
      { ruleId: 'security.scan.official.secrets', owner: 'security', fingerprint: 'sec:1' },
      { ruleId: 'deps.scan.official.cve', owner: 'deps', fingerprint: 'cve:1' },
    ]);
    expect(result.unrouted).toEqual([]);
  });

  it('Given 自报 owner 与注册表冲突，When 路由，Then 不投递且上报 owner-conflict（fail loud）', () => {
    const result = routeFindings([
      { ruleId: 'inspect.scan.official.duplication', fingerprint: 'dup:1', owner: 'inspect' },
    ]);

    expect(result.byOwner.refactor).toBeUndefined();
    expect(result.unrouted).toHaveLength(1);
    expect(result.unrouted[0]?.reason).toBe('owner-conflict');
  });

  it('Given 注册表外 ruleId，When 路由，Then 上报 no-owner 而不是静默丢弃', () => {
    const result = routeFindings([{ ruleId: 'unknown.family.thing', fingerprint: 'x:1' }]);

    expect(result.unrouted).toHaveLength(1);
    expect(result.unrouted[0]?.reason).toBe('no-owner');
    expect(result.distribution).toEqual([]);
  });
});

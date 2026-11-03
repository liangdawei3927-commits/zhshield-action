/**
 * A12 批量派发：多条 semgrep 规则合并成一次进程，且归属不许串
 *
 * 背景（2026-11-03 进程级实测）：一轮 `pipeline --full` 安全域 `semgrep scan ×11`，
 * 每条 SOP 规则各写一份临时 `--config`，argv 天然不同 → 运行作用域去重看不见。
 * 合并后 ≥11 → 1，代价是必须能**把命中准确分回各自规则**。
 *
 * 本文件锁住五件事：
 *   ① 两条请求只起一次进程，合并后的配置里是加了前缀的 id（原始 id 不得裸奔）；
 *   ② 命中按前缀分回各自请求，且 ruleId / fingerprint **还原成原始 id**（与逐条扫描等价）；
 *   ③ semgrep 会把 `--config` 文件路径当前缀编进 check_id（`<路径>.zhb0--a1`），
 *      必须按末段识别 —— 只做全等匹配会让所有命中"认不出归属"，全被判干净；
 *   ④ 有命中无法归属 → **失败关闭**（所有请求判 error），绝不折算成"干净"；
 *   ⑤ 不满足合并条件（路径 config / 少于两条 / 目标不同）时**不合并**，返回空表退回逐条。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import { SemgrepAdapter } from '../adapters/semgrep-adapter';

const execFileMock = vi.mocked(execFile);

const tempDirs: string[] = [];
function tempProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'semgrep-batch-'));
  tempDirs.push(dir);
  return dir;
}

/** 每次 spawn 的证据：argv + 被读走的内联规则 YAML */
const spawns: Array<{ args: string[]; ruleYaml: string }> = [];

function mockScan(results: Array<{ checkId: string; line: number }>): void {
  execFileMock.mockImplementation(((
    _file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    const configIndex = args.indexOf('--config');
    const rulePath = configIndex >= 0 ? args[configIndex + 1] : '';
    let ruleYaml: string;
    try {
      ruleYaml = readFileSync(rulePath, 'utf-8');
    } catch {
      ruleYaml = '';
    }
    spawns.push({ args, ruleYaml });
    const target = args[args.length - 1];
    const stdout = JSON.stringify({
      version: '1.172.0',
      results: results.map((r) => ({
        check_id: r.checkId,
        path: path.join(target, 'index.ts'),
        start: { line: r.line, col: 1 },
        end: { line: r.line, col: 10 },
        extra: { message: `hit ${r.checkId}`, severity: 'ERROR' },
      })),
      errors: [],
    });
    cb(null, { stdout, stderr: '' });
  }) as never);
}

function inlineRule(id: string): Record<string, unknown> {
  return {
    id,
    pattern: 'eval($X)',
    severity: 'ERROR',
    message: `rule ${id}`,
    language: 'typescript',
  };
}

function optionsWith(dir: string, ids: string[]): Parameters<SemgrepAdapter['scan']>[0] {
  return {
    projectPath: dir,
    projectId: dir,
    config: { enabled: true, rules: ids.map(inlineRule) },
  } as Parameters<SemgrepAdapter['scan']>[0];
}

beforeEach(() => {
  spawns.length = 0;
  execFileMock.mockReset();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SemgrepAdapter.scanBatch — 合并成一次进程且归属不串', () => {
  /** 只数真正的 scan 派发（命令解析阶段的 `--version` 探测不算扫描进程） */
  const scanSpawns = (): typeof spawns => spawns.filter((s) => s.args[0] === 'scan');

  it('两条请求只起一次进程，配置里是加前缀的 id，命中还原成原始 id 分回各自请求', async () => {
    const dir = tempProject();
    mockScan([
      { checkId: 'zhb0--a1', line: 3 },
      { checkId: 'zhb1--b1', line: 7 },
    ]);

    const out = await new SemgrepAdapter().scanBatch([
      { key: 'ruleA', options: optionsWith(dir, ['a1']) },
      { key: 'ruleB', options: optionsWith(dir, ['b1']) },
    ]);

    // ① 一次进程 + 一份合并配置，前缀存在、原始 id 不裸奔
    const scans = scanSpawns();
    expect(scans).toHaveLength(1);
    expect(scans[0].ruleYaml).toContain('zhb0--a1');
    expect(scans[0].ruleYaml).toContain('zhb1--b1');
    expect(scans[0].ruleYaml).not.toContain('id: "a1"');

    // ② 归属正确且 id/fingerprint 已还原
    const a = out.get('ruleA');
    const b = out.get('ruleB');
    expect(a?.issues).toHaveLength(1);
    expect(b?.issues).toHaveLength(1);
    expect(a?.issues[0].line).toBe(3);
    expect(b?.issues[0].line).toBe(7);
    expect(a?.issues[0].ruleId).toBe('a1');
    expect(b?.issues[0].ruleId).toBe('b1');
    expect(a?.issues[0].fingerprint).toBe(`semgrep:a1:${path.join(dir, 'index.ts')}:3`);
    expect(b?.issues[0].fingerprint).toBe(`semgrep:b1:${path.join(dir, 'index.ts')}:7`);
    expect(a?.status).toBe('available');
  });

  it('semgrep 把 config 路径前缀编进 check_id 时仍能归属（真实形状，2026-11-03 实测）', async () => {
    const dir = tempProject();
    const configPath = '/var/folders/xx/T/zhshield-semgrep-abcd/inline-rules.yml';
    const prefix = configPath.replace(/[/.-]/g, '.').replace(/^\./, '');
    mockScan([
      { checkId: `${prefix}.zhb0--a1`, line: 4 },
      { checkId: `${prefix}.zhb1--b1`, line: 9 },
    ]);

    const out = await new SemgrepAdapter().scanBatch([
      { key: 'ruleA', options: optionsWith(dir, ['a1']) },
      { key: 'ruleB', options: optionsWith(dir, ['b1']) },
    ]);

    expect(out.get('ruleA')?.issues.map((i) => i.ruleId)).toEqual(['a1']);
    expect(out.get('ruleB')?.issues.map((i) => i.ruleId)).toEqual(['b1']);
    expect(out.get('ruleA')?.issues[0].line).toBe(4);
    expect(out.get('ruleB')?.issues[0].line).toBe(9);
  });

  it('有命中无法归属 → 失败关闭：所有请求都判 error，绝不折算成"干净"', async () => {
    const dir = tempProject();
    mockScan([
      { checkId: 'zhb0--a1', line: 1 },
      { checkId: 'some.registry.rule.we.cannot.map', line: 2 },
    ]);

    const out = await new SemgrepAdapter().scanBatch([
      { key: 'ruleA', options: optionsWith(dir, ['a1']) },
      { key: 'ruleB', options: optionsWith(dir, ['b1']) },
    ]);

    expect(out.get('ruleA')?.status).toBe('error');
    expect(out.get('ruleB')?.status).toBe('error');
    expect(out.get('ruleA')?.error).toContain('无法归属');
  });

  it('同一条规则的多条命中全部归自己', async () => {
    const dir = tempProject();
    mockScan([
      { checkId: 'zhb0--a1', line: 1 },
      { checkId: 'zhb0--a1', line: 5 },
    ]);

    const out = await new SemgrepAdapter().scanBatch([
      { key: 'ruleA', options: optionsWith(dir, ['a1', 'a2']) },
      { key: 'ruleB', options: optionsWith(dir, ['b1']) },
    ]);

    expect(out.get('ruleA')?.issues.map((i) => i.line)).toEqual([1, 5]);
    expect(out.get('ruleB')?.issues).toEqual([]);
  });

  it('整体执行失败时把失败分发给所有 key —— 绝不折算成"干净"', async () => {
    const dir = tempProject();
    execFileMock.mockImplementation(((
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error) => void,
    ) => {
      cb(Object.assign(new Error('boom'), { code: 'ENOENT' }) as Error);
    }) as never);

    const out = await new SemgrepAdapter().scanBatch([
      { key: 'ruleA', options: optionsWith(dir, ['a1']) },
      { key: 'ruleB', options: optionsWith(dir, ['b1']) },
    ]);

    expect(out.get('ruleA')?.status).toBe('unavailable');
    expect(out.get('ruleB')?.status).toBe('unavailable');
    expect(out.get('ruleA')?.error).toBeTruthy();
  });

  it('少于两条 / 带路径 config / 目标不同 → 不合并，返回空表退回逐条', async () => {
    const dir = tempProject();
    const adapter = new SemgrepAdapter();

    const single = await adapter.scanBatch([{ key: 'only', options: optionsWith(dir, ['a1']) }]);
    expect(single.size).toBe(0);

    const withPathConfig = await adapter.scanBatch([
      {
        key: 'cfg',
        options: {
          projectPath: dir,
          config: { enabled: true, config: 'p/typescript/security' },
        } as Parameters<SemgrepAdapter['scan']>[0],
      },
      { key: 'inline', options: optionsWith(dir, ['b1']) },
    ]);
    expect(withPathConfig.size).toBe(0);

    const dir2 = tempProject();
    const mixedTarget = await adapter.scanBatch([
      { key: 'one', options: optionsWith(dir, ['a1']) },
      { key: 'two', options: optionsWith(dir2, ['b1']) },
    ]);
    expect(mixedTarget.size).toBe(0);

    expect(scanSpawns()).toHaveLength(0);
  });
});

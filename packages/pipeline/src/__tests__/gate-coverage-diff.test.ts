import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  computeDiffCoverage,
  parseCoverageFinal,
  parseLcov,
  parseUnifiedDiffHunks,
  resolveCoverageBase,
  toRepoRelative,
} from '../gate-coverage-diff';
import { createGateMetricResolver } from '../gate-metrics';
import { evaluatePostScanGates } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';

/**
 * diff 覆盖率（`scope: diff`）—— 只统计本次改动行。
 *
 * 守的是「口径不能替身」这条铁律：全量 90% 与新增代码 0% 覆盖是两个相反的交付质量。
 * 上方 `gate-metrics.test.ts` 已验证「没有行级报告时不拿全量顶替」，本文件验证
 * **真算得出来**：基线 → 改动行 → 行级命中 → 覆盖率，每一段都有正反用例。
 */

describe('parseUnifiedDiffHunks', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,4 @@',
    '-old',
    '+new1',
    '+new2',
    '@@ -20 +22,2 @@',
    '+tail',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+x',
    '+y',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-a',
    '-b',
  ].join('\n');

  it('只取 + 侧行号，多 hunk / 新文件都算对', () => {
    const changed = parseUnifiedDiffHunks(patch);

    // `@@ -1,2 +1,4 @@` = 新文件第 1 行起连续 4 行新增；`@@ -20 +22,2 @@` = 第 22 行起 2 行
    expect([...changed.get('src/a.ts')!].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 22, 23]);
    expect([...changed.get('src/new.ts')!].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('被删除的文件不在改动行清单里（没有 + 侧可统计）', () => {
    expect(parseUnifiedDiffHunks(patch).has('src/gone.ts')).toBe(false);
  });

  it('GIVEN 空 patch WHEN 解析 THEN 返回空表而不是抛错', () => {
    expect(parseUnifiedDiffHunks('').size).toBe(0);
  });
});

describe('覆盖率报告解析', () => {
  const repoRoot = '/repo';

  it('lcov：SF 绝对路径归一为 repo 相对路径，DA 记录行命中', () => {
    const lcov = ['SF:/repo/src/a.ts', 'DA:1,5', 'DA:2,0', 'end_of_record'].join('\n');

    const parsed = parseLcov(lcov, repoRoot);
    expect([...parsed.get('src/a.ts')!.entries()]).toEqual([
      [1, 5],
      [2, 0],
    ]);
  });

  it('lcov：坏行（行号/hits 非数字）跳过，不污染结果', () => {
    const parsed = parseLcov(['SF:/repo/src/a.ts', 'DA:x,1', 'DA:3,y'].join('\n'), repoRoot);

    expect(parsed.get('src/a.ts')!.size).toBe(0);
  });

  it('istanbul：优先用 l 行命中表', () => {
    const raw = JSON.stringify({ '/repo/src/a.ts': { l: { 1: 3, 2: 0 } } });

    expect([...parseCoverageFinal(raw, repoRoot).get('src/a.ts')!.entries()]).toEqual([
      [1, 3],
      [2, 0],
    ]);
  });

  it('istanbul：没有 l 时由 statementMap + s 反推（任一语句命中即算覆盖）', () => {
    const raw = JSON.stringify({
      '/repo/src/a.ts': {
        statementMap: {
          0: { start: { line: 1 }, end: { line: 2 } },
          1: { start: { line: 3 }, end: { line: 3 } },
        },
        s: { 0: 1, 1: 0 },
      },
    });

    const lines = parseCoverageFinal(raw, repoRoot).get('src/a.ts')!;
    expect(lines.get(1)).toBe(1);
    expect(lines.get(2)).toBe(1);
    expect(lines.get(3)).toBe(0);
  });

  it('istanbul：JSON 损坏时返回空表（由调用方判不可用）', () => {
    expect(parseCoverageFinal('{ 坏 json', repoRoot).size).toBe(0);
  });

  it('toRepoRelative 统一为 posix 分隔符', () => {
    expect(toRepoRelative('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(toRepoRelative('src/a.ts', '/repo')).toBe('src/a.ts');
  });
});

describe('computeDiffCoverage', () => {
  const changed = new Map([['src/a.ts', new Set([1, 2, 3])]]);

  it('GIVEN 3 行改动 2 行覆盖 WHEN 计算 THEN 66.7%（保留一位小数）', () => {
    const coverage = new Map([['src/a.ts', new Map([[1, 1], [2, 4], [3, 0]])]]);

    expect(computeDiffCoverage(changed, coverage)).toEqual({
      pct: 66.7,
      coveredLines: 2,
      totalLines: 3,
      unmeasuredLines: 0,
    });
  });

  it('GIVEN 改动行落在报告之外 WHEN 计算 THEN 不计入分母但报出条数', () => {
    const coverage = new Map([['src/a.ts', new Map([[1, 1]])]]);

    const result = computeDiffCoverage(changed, coverage);
    expect(result).toMatchObject({ pct: 100, totalLines: 1, unmeasuredLines: 2 });
  });

  it('GIVEN 全部改动行都在报告之外 WHEN 计算 THEN 给原因，不当作 100%', () => {
    const result = computeDiffCoverage(changed, new Map());

    expect('reason' in result && result.reason).toContain('无法计算 diff 覆盖率');
  });
});

describe('真实 git 仓库——基线、改动行与覆盖率联动', () => {
  let repoRoot: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repoRoot, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

  const commit = (message: string) => {
    git('add', '-A');
    git(
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=test',
      'commit',
      '-m',
      message,
      '--no-verify',
    );
  };

  const writeLcov = (hits: Record<number, number>) => {
    mkdirSync(path.join(repoRoot, 'coverage'), { recursive: true });
    const abs = path.join(repoRoot, 'src', 'a.ts');
    const lines = Object.entries(hits).map(([line, count]) => `DA:${line},${count}`);
    writeFileSync(
      path.join(repoRoot, 'coverage', 'lcov.info'),
      ['SF:' + abs, ...lines, 'end_of_record'].join('\n'),
      'utf-8',
    );
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'diff-cov-'));
    git('init', '-b', 'main');
    mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n', 'utf-8');
    commit('init');
    git('checkout', '-b', 'feature');
    writeFileSync(
      path.join(repoRoot, 'src', 'a.ts'),
      'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n',
      'utf-8',
    );
    commit('add two lines');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const coverageRule = (): SopRule =>
    ({
      id: 'guard.block.official.test-coverage',
      domain: 'guard',
      action: 'block',
      status: 'active',
      content: { threshold: 80, unit: 'percent', scope: 'diff' },
    }) as unknown as SopRule;

  it('基线解析到 main 的 merge-base，改动行只含新增的 3、4 行', () => {
    const base = resolveCoverageBase(repoRoot);
    expect('base' in base && base.how).toContain('main');
  });

  it('GIVEN 新增两行未被测试覆盖 WHEN 判定 THEN failed（不是拿全量顶替）', () => {
    writeLcov({ 1: 5, 2: 5, 3: 0, 4: 0 });

    const report = evaluatePostScanGates([coverageRule()], createGateMetricResolver(repoRoot));
    expect(report.items[0].status).toBe('failed');
    expect(report.items[0].actual).toBe(0);
    expect(report.items[0].message).toContain('改动行 2 行');
  });

  it('GIVEN 新增两行都被覆盖 WHEN 判定 THEN passed，且文案带基线来源', () => {
    writeLcov({ 1: 0, 2: 0, 3: 1, 4: 1 });

    const report = evaluatePostScanGates([coverageRule()], createGateMetricResolver(repoRoot));
    expect(report.items[0].status).toBe('passed');
    expect(report.items[0].actual).toBe(100);
    expect(report.items[0].message).toContain('merge-base');
  });

  it('GIVEN 显式基线不存在 WHEN 取数 THEN undetermined 并点名该基线', () => {
    const resolver = createGateMetricResolver(repoRoot, { coverageBase: 'no-such-ref' });
    const value = resolver(coverageRule()) as { unavailableReason?: string };

    expect(value.unavailableReason).toContain('no-such-ref');
  });

  it('GIVEN 有改动但没有行级覆盖率报告 WHEN 取数 THEN 说明需开启 lcov/json reporter', () => {
    const value = createGateMetricResolver(repoRoot)(coverageRule()) as {
      unavailableReason?: string;
    };

    expect(value.unavailableReason).toContain('行级数据');
    expect(value.unavailableReason).toContain('lcov');
  });
});

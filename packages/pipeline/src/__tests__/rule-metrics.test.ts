import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createRuleMetricsProvider, readDeclaredMetricKeys } from '../rule-metrics';
import type { SopRule } from '@zh/kernel';

/**
 * 度量提供者：把「规则声明要什么」翻译成真实测量值。
 *
 * 这一层的职责边界：只回答「测到什么」，不回答「算不算通过」（那是 evalThreshold 的事）。
 * 因此每个用例都在守同一条铁律 —— **测不到就给不出，绝不拿近似值顶替**。
 */
describe('createRuleMetricsProvider', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'rule-metrics-provider-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const rule = (overrides: Partial<SopRule> & { id: string }): SopRule =>
    ({
      name: overrides.id,
      domain: 'inspect',
      action: 'scan',
      source: 'official',
      description: '',
      status: 'active',
      executionMode: 'sync',
      severity: 'warning',
      applicableEngines: ['inspect'],
      tags: [],
      falsePositiveCount: 0,
      truePositiveCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      content: {},
      ...overrides,
    }) as SopRule;

  const writeSource = (relPath: string, content: string) => {
    const full = path.join(repoRoot, relPath);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf-8');
  };

  describe('复杂度', () => {
    it('GIVEN 存在深层嵌套函数 WHEN 采集 THEN 五项指标均为真实测量值', () => {
      writeSource(
        'src/messy.ts',
        [
          'export function messy(a: number, b: number, c: number, d: number, e: number, f: number) {',
          '  if (a) {',
          '    for (let i = 0; i < b; i++) {',
          '      while (c) {',
          '        if (d) {',
          '          if (e) {',
          '            return f;',
          '          }',
          '        }',
          '      }',
          '    }',
          '  }',
          '  return 0;',
          '}',
        ].join('\n'),
      );

      const provider = createRuleMetricsProvider(repoRoot);
      const result = provider(
        rule({ id: 'inspect.scan.official.complexity', content: { thresholds: {
          cyclomaticComplexity: 10,
          functionLength: 50,
          fileLength: 300,
          nestingDepth: 4,
          parameterCount: 5,
        } } }),
        { repoRoot },
      ) as { metrics?: Record<string, number> };

      expect(result.metrics).toBeDefined();
      const m = result.metrics!;
      // 五个指标必须都在：少一个就会被判「整条未执行」
      expect(Object.keys(m).sort()).toEqual([
        'cyclomaticComplexity',
        'fileLength',
        'functionLength',
        'nestingDepth',
        'parameterCount',
      ]);
      expect(m.parameterCount).toBe(6);
      expect(m.nestingDepth).toBeGreaterThanOrEqual(4);
      expect(m.cyclomaticComplexity).toBeGreaterThanOrEqual(5);
      expect(m.functionLength).toBeGreaterThan(10);
      expect(m.fileLength).toBe(14);
    });

    it('GIVEN 仓库里同时有源码与 node_modules WHEN 采集 THEN 只统计源码', () => {
      writeSource('src/ok.ts', 'export function small() {\n  return 1;\n}\n');
      writeSource(
        'node_modules/pkg/index.ts',
        'export function huge(a,b,c,d,e,f,g,h) {\n' + '  if (a) { if (b) { if (c) { if (d) { return 1 } } } }\n'.repeat(3) + '}\n',
      );

      const provider = createRuleMetricsProvider(repoRoot);
      const result = provider(
        rule({ id: 'inspect.scan.official.complexity', content: { thresholds: { parameterCount: 5 } } }),
        { repoRoot },
      ) as { metrics?: Record<string, number> };

      // 若把 node_modules 算进来，parameterCount 会是 8
      expect(result.metrics!.parameterCount).toBe(0);
    });

    it('GIVEN 源文件数超过上限 WHEN 采集 THEN 不给指标并说明原因', () => {
      writeSource('a.ts', 'export const a = 1;\n');
      writeSource('b.ts', 'export const b = 1;\n');

      const provider = createRuleMetricsProvider(repoRoot, { maxScanFiles: 1 });
      const result = provider(
        rule({ id: 'inspect.scan.official.complexity', content: { thresholds: { fileLength: 300 } } }),
        { repoRoot },
      ) as { metrics?: Record<string, number>; unavailableReason?: string };

      expect(result.metrics).toBeUndefined();
      expect(result.unavailableReason).toContain('上限');
    });

    it('GIVEN 无任何源文件 WHEN 采集 THEN 不给指标', () => {
      const provider = createRuleMetricsProvider(repoRoot);
      const result = provider(
        rule({ id: 'inspect.scan.official.complexity', content: { thresholds: { fileLength: 300 } } }),
        { repoRoot },
      ) as { metrics?: Record<string, number>; unavailableReason?: string };

      expect(result.metrics).toBeUndefined();
      expect(result.unavailableReason).toContain('未找到可分析的源文件');
    });

    it('GIVEN 生成物目录（dist-electron）与打包产物 WHEN 采集 THEN 不算源码', () => {
      // 2026-10-29 实测：只匹配精确名 `dist` 时，desktop/dist-electron 下 12 个 800KB
      // 的 esbuild 产物被当成源码 ⇒ 耗时 250s、fileLength 虚高到 22435 行
      writeSource('src/ok.ts', 'export function small() {\n  return 1;\n}\n');
      writeSource(
        'packages/desktop/dist-electron/main-abc.js',
        'var a=1;' + 'function f(){if(a){while(a){return 1}}}'.repeat(500),
      );
      writeSource('src/legacy/thing.min.js', 'var x=1;'.repeat(1000));

      const provider = createRuleMetricsProvider(repoRoot);
      const result = provider(
        rule({ id: 'inspect.scan.official.complexity', content: { thresholds: { parameterCount: 5 } } }),
        { repoRoot },
      ) as { metrics?: Record<string, number> };

      expect(result.metrics!.parameterCount).toBe(0);
      expect(result.metrics!.nestingDepth).toBe(0);
    });

    it('GIVEN 存在超大源文件 WHEN 采集 THEN 整体放弃而非静默跳过', () => {
      writeSource('src/ok.ts', 'export function small() {\n  return 1;\n}\n');
      writeSource('src/generated-blob.ts', 'export const blob = "' + 'x'.repeat(600 * 1024) + '";\n');

      const provider = createRuleMetricsProvider(repoRoot);
      const result = provider(
        rule({ id: 'inspect.scan.official.complexity', content: { thresholds: { fileLength: 300 } } }),
        { repoRoot },
      ) as { metrics?: Record<string, number>; unavailableReason?: string };

      // 跳过该文件会让 fileLength 偏低 —— 那正是规则要抓的东西，不能悄悄漏掉
      expect(result.metrics).toBeUndefined();
      expect(result.unavailableReason).toContain('generated-blob.ts');
    });

    it('GIVEN 同一实例重复请求 WHEN 采集 THEN 复用同一份统计结果', () => {
      writeSource('src/a.ts', 'export function f() {\n  return 1;\n}\n');
      const provider = createRuleMetricsProvider(repoRoot);
      const r = rule({
        id: 'inspect.scan.official.complexity',
        content: { thresholds: { functionLength: 50 } },
      });

      expect(provider(r, { repoRoot })).toBe(provider(r, { repoRoot }));
    });
  });

  describe('readDeclaredMetricKeys — 与解释器同一口径', () => {
    it('复数 thresholds 取键名，单数 threshold 折叠为 value', () => {
      expect(readDeclaredMetricKeys(rule({ id: 'x', content: { thresholds: { a: 1, b: 2 } } }))).toEqual(
        ['a', 'b'],
      );
      expect(readDeclaredMetricKeys(rule({ id: 'x', content: { threshold: 70 } }))).toEqual(['value']);
    });

    it('嵌套 schema（check 段）与扁平 schema 都能识别', () => {
      expect(
        readDeclaredMetricKeys(rule({ id: 'x', content: { check: { thresholds: { nestingDepth: 4 } } } })),
      ).toEqual(['nestingDepth']);
    });

    it('没有阈值声明时返回空数组（交给引擎判未执行，不算提供者出错）', () => {
      const provider = createRuleMetricsProvider(repoRoot);
      expect(readDeclaredMetricKeys(rule({ id: 'x', content: { patterns: ['a'] } }))).toEqual([]);
      expect(provider(rule({ id: 'x', content: {} }), { repoRoot })).toEqual({ metrics: {} });
    });
  });
});

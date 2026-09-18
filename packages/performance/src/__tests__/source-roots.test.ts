import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveSourceRoots, collectFilesAcrossRoots } from '../source-roots';
import { PerformanceEngine } from '../engine';

/**
 * 源码根发现回归测试。
 *
 * 背景：complexity / tree-shaking 曾写死 `['src']` 且只取第 0 项，
 * monorepo（源码在 packages/*\/src）被静默扫描 0 个文件 → 面板显示 0 问题。
 */
describe('resolveSourceRoots', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-roots-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mkdir = (rel: string): string => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('单包项目：识别顶层 src/', () => {
    const src = mkdir('src');
    expect(resolveSourceRoots(root)).toEqual([src]);
  });

  it('单包项目：识别 app/ 路由目录', () => {
    const app = mkdir('app');
    expect(resolveSourceRoots(root)).toEqual([app]);
  });

  it('monorepo：识别 packages/*/src 与 apps/*/src，且顺序稳定', () => {
    const a = mkdir('packages/a/src');
    const b = mkdir('packages/b/src');
    const web = mkdir('apps/web/src');
    expect(resolveSourceRoots(root)).toEqual([a, b, web]);
    // 顺序稳定：连续两次调用结果一致
    expect(resolveSourceRoots(root)).toEqual(resolveSourceRoots(root));
  });

  it('不把同级非 src 目录当成源码根', () => {
    mkdir('packages/a/dist');
    mkdir('packages/a/lib');
    expect(resolveSourceRoots(root)).toEqual([]);
  });

  it('无源码根时返回空数组（供引擎报覆盖缺口，而非静默 0 问题）', () => {
    mkdir('docs');
    expect(resolveSourceRoots(root)).toEqual([]);
  });

  it('collectFilesAcrossRoots 共享总量预算，不会每个根各扫满', () => {
    const r1 = mkdir('packages/a/src');
    const r2 = mkdir('packages/b/src');
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(r1, `a${i}.ts`), '');
      fs.writeFileSync(path.join(r2, `b${i}.ts`), '');
    }
    const collect = (dir: string, limit: number): string[] =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.ts'))
        .slice(0, limit)
        .map((f) => path.join(dir, f));
    expect(collectFilesAcrossRoots([r1, r2], collect, 6)).toHaveLength(6);
  });
});

describe('PerformanceEngine 覆盖缺口提示', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-cover-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('有 package.json 但无源码根 → 显式产出 coverage.no-source-root', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    const report = new PerformanceEngine().scan(root);
    const coverage = report.issues.find((i) => i.ruleId === 'coverage.no-source-root');
    expect(coverage).toBeDefined();
    expect(coverage!.severity).toBe('info');
  });

  it('无 package.json 也无源码根 → 不是项目根，不产出提示', () => {
    const report = new PerformanceEngine().scan(root);
    expect(report.issues.find((i) => i.ruleId === 'coverage.no-source-root')).toBeUndefined();
  });

  it('monorepo 根（无顶层 src）不再被判为「无源码」', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    const pkgSrc = path.join(root, 'packages', 'a', 'src');
    fs.mkdirSync(pkgSrc, { recursive: true });
    fs.writeFileSync(
      path.join(pkgSrc, 'hot.ts'),
      'export function f(files: string[]) {\n  for (const a of files) {\n    for (const b of files) {\n      for (const c of files) {\n        console.log(a, b, c);\n      }\n    }\n  }\n}\n',
    );
    const report = new PerformanceEngine().scan(root);
    expect(report.issues.find((i) => i.ruleId === 'coverage.no-source-root')).toBeUndefined();
    expect(report.issues.some((i) => i.ruleId === 'complexity.nested-loop')).toBe(true);
  });

  it('测试与夹具代码不参与产品性能判定（误报控制）', () => {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'x', version: '1.0.0' }),
    );
    const src = path.join(root, 'src');
    const tests = path.join(src, '__tests__');
    fs.mkdirSync(tests, { recursive: true });
    fs.writeFileSync(path.join(src, 'prod.spec.ts'), 'export const x = 1;\nreadFileSync("/a");\n');
    fs.writeFileSync(path.join(tests, 'a.test.ts'), 'export const y = 1;\nreadFileSync("/b");\n');
    fs.writeFileSync(path.join(src, 'real.ts'), 'export const z = 1;\nreadFileSync("/c");\n');

    const report = new PerformanceEngine().scan(root);
    const syncIo = report.issues.filter((i) => i.ruleId === 'complexity.sync-io');
    expect(syncIo.map((i) => i.file)).toEqual(['src/real.ts']);
  });
});

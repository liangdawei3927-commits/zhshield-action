/**
 * required-content 的 extends 链解析（strict-mode 规则的已知边界修复）
 *
 * 背景：strict-mode 规则只查仓库根 tsconfig.json；当 strict 等开关定义在
 * extends 的 base 配置里时，根配置缺键 → 误报「缺少配置项」。
 * 修复：checkRequiredJson 在评估键路径前，沿 extends 链深合并出生效配置。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

describe('SopRuleEngine — required-content extends 链深合并', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'required-extends-test-'));
    registry.register(
      makeRule({
        id: 'inspect.scan.internal.strict-mode',
        domain: 'inspect',
        content: {
          required: [{ path: 'tsconfig.json', json: { 'compilerOptions.strict': true } }],
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function evaluate() {
    return engine.evaluateRules({ repoRoot: tempDir });
  }

  it('strict 定义在 extends 的 base 里 → 不再误报', async () => {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ extends: './tsconfig.base.json' }),
      'utf-8',
    );
    writeFileSync(
      path.join(tempDir, 'tsconfig.base.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
      'utf-8',
    );
    const report = await evaluate();
    expect(report.passed).toBe(1);
  });

  it('子配置覆盖 base → 以子配置为准（strict=false 仍报 failed）', async () => {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { strict: false } }),
      'utf-8',
    );
    writeFileSync(
      path.join(tempDir, 'tsconfig.base.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
      'utf-8',
    );
    const report = await evaluate();
    expect(report.failed).toBe(1);
  });

  it('多层 extends 链逐级合并', async () => {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { noImplicitAny: true } }),
      'utf-8',
    );
    writeFileSync(
      path.join(tempDir, 'tsconfig.base.json'),
      JSON.stringify({ extends: './grandparent.json' }),
      'utf-8',
    );
    writeFileSync(
      path.join(tempDir, 'grandparent.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
      'utf-8',
    );
    const report = await evaluate();
    expect(report.passed).toBe(1);
  });

  it('循环 extends 不死循环，仍能取到有效配置', async () => {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ extends: './a.json' }),
      'utf-8',
    );
    writeFileSync(
      path.join(tempDir, 'a.json'),
      JSON.stringify({ extends: './b.json' }),
      'utf-8',
    );
    writeFileSync(
      path.join(tempDir, 'b.json'),
      JSON.stringify({ extends: './tsconfig.json', compilerOptions: { strict: true } }),
      'utf-8',
    );
    const report = await evaluate();
    expect(report.passed).toBe(1);
  });

  it('extends 指向不可解析目标 → 回退为只查本文件（原有行为）', async () => {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ extends: './不存在.json' }),
      'utf-8',
    );
    const report = await evaluate();
    expect(report.failed).toBe(1);
  });

  it('base 是 node_modules 里的共享配置（@tsconfig 风格）→ 也能解析', async () => {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({ extends: '@tsconfig/strictest/tsconfig.json' }),
      'utf-8',
    );
    const pkgDir = path.join(tempDir, 'node_modules', '@tsconfig', 'strictest');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
      'utf-8',
    );
    const report = await evaluate();
    expect(report.passed).toBe(1);
  });
});

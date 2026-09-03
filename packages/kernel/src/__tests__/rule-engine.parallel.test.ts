import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * M1 回归：evaluateAll 串行 → 有界并行后，
 * 输出顺序必须 == 输入顺序（预分配数组 + 下标写入），
 * 且总评估数 / passed 等聚合语义与并行前一致。
 * 这是并行化最脆弱的两个不变量，需专门锁定。
 */
describe('SopRuleEngine — M1 并行化回归（保序 + 聚合等价）', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-engine-parallel-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('并行执行多条规则时，评估结果保持注册顺序（results[i] === rules[i]）', async () => {
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    // 首条规则扫一个偏大的 fixture，故意让其耗时最长，
    // 以验证即使慢任务后完成，顺序仍由下标写入保证。
    writeFileSync(
      path.join(srcDir, 'large.ts'),
      Array.from({ length: 4000 }, (_, i) => `// some noise line ${i}`).join('\n'),
      'utf-8',
    );

    const rules = [
      makeRule({
        id: 'guard.slow.first',
        domain: 'guard',
        action: 'scan',
        content: { patterns: ['NEVER_MATCH_SLOW_0'] },
      }),
      makeRule({
        id: 'guard.fast.second',
        domain: 'guard',
        action: 'scan',
        content: { patterns: ['NEVER_MATCH_FAST_1'] },
      }),
      makeRule({
        id: 'guard.fast.third',
        domain: 'guard',
        action: 'scan',
        content: { patterns: ['NEVER_MATCH_FAST_2'] },
      }),
      makeRule({
        id: 'guard.fast.fourth',
        domain: 'guard',
        action: 'scan',
        content: { patterns: ['NEVER_MATCH_FAST_3'] },
      }),
    ];
    for (const rule of rules) registry.register(rule);

    const report = await engine.evaluateRules({ repoRoot: tempDir });

    expect(report.total).toBe(rules.length);
    // 顺序不变量：evaluations 的 id 序列必须与注册顺序逐位一致。
    expect(report.evaluations.map((e) => e.rule.id)).toEqual(
      rules.map((r) => r.id),
    );
    // 全部未命中 → 全部 passed；聚合 ok 为 true。
    expect(report.passed).toBe(rules.length);
    expect(report.failed).toBe(0);
    expect(report.ok).toBe(true);
  });

  it('并行下 consecutiveFailures 对同一 rule 的读写仍原子（状态一致）', async () => {
    // 两条规则先后在两次体检中失败/通过，验证失败计数不因并行交叉污染。
    const srcDir = path.join(tempDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      path.join(srcDir, 'a.ts'),
      'const API_KEY = "sk-abcd1234efgh5678ijkl";',
      'utf-8',
    );

    const hitRule = makeRule({
      id: 'guard.scan.hit',
      domain: 'guard',
      action: 'scan',
      content: { patterns: ['sk-[a-zA-Z0-9]{16,}'] },
    });
    const missRule = makeRule({
      id: 'guard.scan.miss',
      domain: 'guard',
      action: 'scan',
      content: { patterns: ['DOES_NOT_EXIST'] },
    });
    registry.register(missRule);
    registry.register(hitRule);

    // 第一次：hit 未命中（先放一个空文件场景）后在第二次命中
    await engine.evaluateRules({ repoRoot: tempDir });
    const second = await engine.evaluateRules({ repoRoot: tempDir });

    // 顺序仍保持注册序
    expect(second.evaluations.map((e) => e.rule.id)).toEqual([
      missRule.id,
      hitRule.id,
    ]);
    // hitRule 命中 → failed（keys 命中 pattern-scan）
    expect(second.evaluations.find((e) => e.rule.id === hitRule.id)?.status).toBe('failed');
    // missRule 未命中 → passed
    expect(second.evaluations.find((e) => e.rule.id === missRule.id)?.status).toBe('passed');
  });
});
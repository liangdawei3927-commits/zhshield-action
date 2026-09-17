import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { SopRuleEngine, ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * 「静默空跑」护栏回归（2026-09-17 定案）
 *
 * 背景：content 无法解释为任何可执行指令时（典型写法错误 = check.rules 声明了内联
 * 检查项却缺 check.tool），旧实现兜底返回 pattern-scan + JSON.stringify(content)，
 * 把整份规则 JSON 当字面量去源码里搜 —— 必然 0 命中 → 恒定 passed。
 * 实证受害者：inspect.scan.ironnest.module-boundary、inspect.scan.internal.type-consistency
 * 两条 active 规则在面板上显示通过勾，实际从未执行任何检查。
 *
 * 现在：兜底返回 unresolved，引擎落 degraded skipped，使 aggregate() 的 ok=false。
 */
describe('ContentInterpreter — unresolved 兜底（禁止静默空跑）', () => {
  const interpreter = new ContentInterpreter();

  it('check.rules 缺 check.tool → unresolved，并给出可操作的修复指引', () => {
    const rule = makeRule({
      id: 'test.unresolved.missing-tool',
      content: {
        rules: [{ id: 'no-implicit-any', severity: 'warning' }],
        check: { rules: [{ id: 'no-implicit-any', severity: 'warning' }] },
      },
    });

    const instr = interpreter.interpret(rule);
    expect(instr.type).toBe('unresolved');
    if (instr.type === 'unresolved') {
      expect(instr.reason).toContain('check.rules');
      expect(instr.reason).toContain('check.tool');
      expect(instr.keys).toContain('check');
    }
  });

  it('空 content → unresolved', () => {
    const instr = interpreter.interpret(makeRule({ id: 'test.unresolved.empty', content: {} }));
    expect(instr.type).toBe('unresolved');
    if (instr.type === 'unresolved') {
      expect(instr.reason).toContain('为空');
      expect(instr.keys).toEqual([]);
    }
  });

  it('未知写法 → unresolved，并列出顶层键名', () => {
    const instr = interpreter.interpret(
      makeRule({ id: 'test.unresolved.unknown', content: { someFutureField: 1 } }),
    );
    expect(instr.type).toBe('unresolved');
    if (instr.type === 'unresolved') {
      expect(instr.keys).toEqual(['someFutureField']);
      expect(instr.reason).toContain('someFutureField');
    }
  });

  it('兜底不得再退化为「把整份规则 JSON 当字面量搜源码」', () => {
    const instr = interpreter.interpret(
      makeRule({
        id: 'test.unresolved.no-json-scan',
        content: { check: { rules: [{ id: 'x' }] } },
      }),
    );
    // 旧行为是 pattern-scan + patterns:[JSON.stringify(content)]，会恒判 passed
    expect(instr.type).not.toBe('pattern-scan');
    expect(instr.type).toBe('unresolved');
  });
});

describe('SopRuleEngine — unresolved 规则不得判通过', () => {
  let registry: SopRegistry;
  let engine: SopRuleEngine;
  let tempDir: string;

  beforeEach(() => {
    registry = new SopRegistry();
    engine = new SopRuleEngine(registry);
    tempDir = mkdtempSync(path.join(tmpdir(), 'rule-engine-unresolved-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('unresolved 规则落 degraded skipped，report.ok=false', async () => {
    registry.register(
      makeRule({
        id: 'inspect.scan.test.unresolved',
        domain: 'guard',
        applicableEngines: ['guard'],
        content: { check: { rules: [{ id: 'no-implicit-any', severity: 'warning' }] } },
      }),
    );

    const report = await engine.evaluateRules({ repoRoot: tempDir, domain: 'guard' });

    expect(report.total).toBe(1);
    expect(report.passed).toBe(0);
    // 关键护栏：什么都没查 ≠ 通过
    expect(report.evaluations[0].status).toBe('skipped');
    expect(report.evaluations[0].degraded).toBe(true);
    expect(report.degraded).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.evaluations[0].message).toContain('规则内容无法解释');
  });
});

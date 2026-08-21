import { describe, it, expect } from 'vitest';

import { ContentInterpreter } from '../runner';
import { makeRule } from './helpers/rule-factory';

describe('ContentInterpreter — 规则内容解释分发', () => {
  const interpreter = new ContentInterpreter();

  it('识别 check.tool 并生成 ToolDispatchInstruction', () => {
    const richRule = makeRule({
      id: 'guard.block.external.eslint-error',
      domain: 'guard',
      content: {
        metadata: { id: 'guard.block.external.eslint-error', name: 'ESLint Error' },
        governance: { domain: 'guard', action: 'block' },
        check: { tool: 'eslint', toolConfig: { configFile: '.eslintrc.cjs' } },
        conditions: { languages: ['typescript'], filePatterns: ['*.ts'] },
        judgment: { passCondition: 'errorCount === 0', priority: 'high' },
      },
    });
    const instr = interpreter.interpret(richRule);
    expect(instr.type).toBe('tool-dispatch');
    if (instr.type === 'tool-dispatch') {
      expect(instr.tool).toBe('eslint');
      expect(instr.toolConfig).toHaveProperty('configFile');
      expect(instr.conditions?.languages).toContain('typescript');
      expect(instr.judgment?.priority).toBe('high');
    }
  });

  it('所有类型均正确分发（含 tool-dispatch）', () => {
    const patternRule = makeRule({
      id: 'test.pattern',
      content: { patterns: ['abc'] },
    });
    expect(interpreter.interpret(patternRule).type).toBe('pattern-scan');

    const checkRule = makeRule({
      id: 'test.checks',
      content: { checks: [{ rule: 'no-console', level: 'error' }] },
    });
    expect(interpreter.interpret(checkRule).type).toBe('check-list');

    const forbiddenRule = makeRule({
      id: 'test.forbidden',
      content: { forbidden: ['as any'] },
    });
    expect(interpreter.interpret(forbiddenRule).type).toBe('forbidden');

    const thresholdRule = makeRule({
      id: 'test.threshold',
      content: { threshold: 80 },
    });
    expect(interpreter.interpret(thresholdRule).type).toBe('threshold');

    const layersRule = makeRule({
      id: 'test.layers',
      content: { layers: [{ name: 'app', allowedDependencies: ['domain'] }] },
    });
    expect(interpreter.interpret(layersRule).type).toBe('layer-boundary');

    const toolDispatchRule = makeRule({
      id: 'test.tool-dispatch',
      content: { check: { tool: 'eslint', toolConfig: {} } },
    });
    expect(interpreter.interpret(toolDispatchRule).type).toBe('tool-dispatch');

    // tool-dispatch 优先级最高：即使有 checks 字段，有 check.tool 时优先
    const mixedRule = makeRule({
      id: 'test.mixed',
      content: {
        check: { tool: 'semgrep', toolConfig: { rules: ['sql-injection'] } },
        patterns: ['some-pattern'],
        checks: [{ rule: 'no-console', level: 'error' }],
      },
    });
    expect(interpreter.interpret(mixedRule).type).toBe('tool-dispatch');
  });
});

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseFile, collectExternalCalls } from '../ast-helper';
import { DEFAULT_CONFIG } from '../types';
import { detectFeatureEnvy } from '../adapters/coupling-detectors';

const FIXTURE = path.resolve(__dirname, 'fixtures', 'feature-envy.fixture.ts');
const parsed = parseFile(FIXTURE);

function smellsFor(className: string): string[] {
  return detectFeatureEnvy(parsed, DEFAULT_CONFIG)
    .filter((s) => s.message.includes(`${className}.`))
    .map((s) => s.message);
}

function externalCallsOf(className: string, methodName: string): Map<string, number> {
  const cls = parsed.classes.find((c) => c.name === className);
  if (!cls) throw new Error(`fixture class not found: ${className}`);
  const method = cls.members.methods.find((m) => m.name === methodName);
  if (!method) throw new Error(`fixture method not found: ${className}.${methodName}`);
  return collectExternalCalls(method.node, cls.name, parsed.sourceFile);
}

describe('collectExternalCalls — 排除非依恋目标', () => {
  it('仅统计类实例参数上的方法调用', () => {
    const calls = externalCallsOf('EnviousFormatter', 'render');
    expect([...calls.keys()].every((key) => key.startsWith('payload.'))).toBe(true);
    expect(calls.get('payload.size')).toBe(1);
    expect(calls.get('payload.serialize')).toBe(1);
  });

  it('不计入值类型参数的调用', () => {
    expect(externalCallsOf('LineAccumulator', 'format').size).toBe(0);
  });

  it('不计入 Node 内置模块导入绑定的调用', () => {
    expect(externalCallsOf('PathProbe', 'resolveTarget').size).toBe(0);
  });

  it('不计入 JS 全局对象与局部变量的调用', () => {
    expect(externalCallsOf('FlagBuilder', 'build').size).toBe(0);
  });
});

describe('detectFeatureEnvy — 误报过滤后仍保留真实检出', () => {
  it('仍检出对类实例参数的真实依恋', () => {
    expect(smellsFor('EnviousFormatter')).toHaveLength(1);
  });

  it('值类型参数不再误报', () => {
    expect(smellsFor('LineAccumulator')).toHaveLength(0);
  });

  it('Node 内置模块调用不再误报', () => {
    expect(smellsFor('PathProbe')).toHaveLength(0);
  });

  it('JS 全局与局部变量调用不再误报', () => {
    expect(smellsFor('FlagBuilder')).toHaveLength(0);
  });
});

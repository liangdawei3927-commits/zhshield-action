import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseFile } from '../ast-helper';
import { DEFAULT_CONFIG } from '../types';
import { detectDataClass } from '../adapters/data-class-detector';

// 源文件写在工作区之外，避开 isTestFixture（排除 __tests__ / fixtures）对 data-class 的豁免，
// 否则测试夹具路径会让检测器恒返回空集。
const SRC = `
export class InjectedPolicy {
  private readonly registry: Registry;
  private readonly resolver: Resolver;
  private readonly strategy: Strategy;
  private readonly metrics: Metrics;
  private readonly eventBus: Bus;

  constructor(options: { registry: Registry; resolver: Resolver; strategy: Strategy; metrics: Metrics; eventBus: Bus }) {
    this.registry = options.registry;
    this.resolver = options.resolver;
    this.strategy = options.strategy;
    this.metrics = options.metrics;
    this.eventBus = options.eventBus;
  }

  resolveIncoming(rule: Rule): Rule {
    const local = this.registry.get(rule.id);
    if (!local) return rule;
    const conflict = this.resolver.detectConflict(local, rule);
    if (!conflict) return rule;
    const resolved = this.resolver.resolve(conflict, this.strategy);
    this.metrics?.record(this.strategy);
    this.eventBus?.emit('resolved', { ruleId: rule.id });
    return { ...rule, ...resolved };
  }
}

export class PureDataHolder {
  public name: string;
  public domain: string;
  public action: string;
  public source: string;
  public status: string;
}

export class DataWithTrivialAccessor {
  public name: string;
  public domain: string;
  public action: string;
  public source: string;
  public status: string;

  getName(): string {
    return this.name;
  }
}
`;

const TMP = path.join(os.tmpdir(), 'zh-data-class-detector-target.ts');

describe('detectDataClass', () => {
  beforeAll(() => {
    fs.writeFileSync(TMP, SRC, 'utf-8');
  });

  afterAll(() => {
    try {
      fs.unlinkSync(TMP);
    } catch {
      /* 清理失败不影响断言 */
    }
  });

  it('does not flag a dependency-injected policy whose single method carries behavior', () => {
    const smells = detectDataClass(parseFile(TMP), DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('InjectedPolicy'))).toBe(false);
  });

  it('still flags a pure data holder (fields only, no methods)', () => {
    const smells = detectDataClass(parseFile(TMP), DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('PureDataHolder'))).toBe(true);
  });

  it('still flags a data holder whose only method is a trivial accessor', () => {
    const smells = detectDataClass(parseFile(TMP), DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('DataWithTrivialAccessor'))).toBe(true);
  });
});

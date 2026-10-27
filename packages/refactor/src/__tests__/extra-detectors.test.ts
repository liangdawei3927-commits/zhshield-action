import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseFile } from '../ast-helper';
import { DEFAULT_CONFIG } from '../types';
import {
  detectMessageChains,
  detectSwitchStatement,
  detectRefusedBequest,
  detectLazyClass,
} from '../adapters/extra-detectors';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const FIXTURE = path.join(FIXTURES_DIR, 'extra-detectors.fixture.ts');

const parsed = parseFile(FIXTURE);

describe('detectSwitchStatement', () => {
  it('exempts pure dispatch switches (every case ends with return/throw)', () => {
    const smells = detectSwitchStatement(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('PureDispatchService'))).toBe(false);
  });

  it('still flags imperative switches with break + shared state', () => {
    const smells = detectSwitchStatement(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('ImperativeSwitchService'))).toBe(true);
  });
});

describe('detectMessageChains', () => {
  it('ignores dots inside string literals (i18n keys)', () => {
    const smells = detectMessageChains(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('I18nRenderer'))).toBe(false);
  });

  it('still flags real chains outside strings', () => {
    const smells = detectMessageChains(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('ChainClient'))).toBe(true);
  });
});

describe('detectRefusedBequest', () => {
  it('exempts Error subclasses', () => {
    const smells = detectRefusedBequest(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('ToolUnavailableError'))).toBe(false);
  });

  it('exempts *Adapter subclasses', () => {
    const smells = detectRefusedBequest(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('SecurityScanAdapter'))).toBe(false);
  });

  it('exempts React Component subclasses', () => {
    const smells = detectRefusedBequest(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('ErrorBoundary'))).toBe(false);
  });

  it('exempts subclasses referencing inherited members (super / this.<baseMember>)', () => {
    const smells = detectRefusedBequest(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('VerifiedClient'))).toBe(false);
  });

  it('still flags empty subclasses that use nothing from the base', () => {
    const smells = detectRefusedBequest(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('EmptyLazySubclass'))).toBe(true);
  });
});

describe('detectLazyClass', () => {
  it('exempts Error subclasses (typed-error contract needs instanceof identity)', () => {
    const smells = detectLazyClass(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('ToolUnavailableError'))).toBe(false);
  });

  it('still flags tiny non-Error classes', () => {
    const smells = detectLazyClass(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('EmptyLazySubclass'))).toBe(true);
  });

  // 2026-10-27 核实修复：接口实现类是契约载体（DI 第二实现 / 测试替身 / 平台适配器），
  // 薄由接口决定，不是设计冗余。此前只豁免装饰器类 / abstract / extends Error。
  it('exempts classes implementing an interface (contract carrier)', () => {
    const smells = detectLazyClass(parsed, DEFAULT_CONFIG);
    expect(smells.some((s) => s.message.includes('InMemorySecretStore'))).toBe(false);
  });

  // 双自证：豁免收紧到 implements，普通小类必须仍被报（否则等于整条规则失效）
  it('does not blanket-exempt every small class (guard against over-suppression)', () => {
    const smells = detectLazyClass(parsed, DEFAULT_CONFIG);
    expect(smells.length).toBeGreaterThan(0);
  });
});
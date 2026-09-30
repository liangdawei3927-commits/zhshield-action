import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseFile } from '../ast-helper';
import { DEFAULT_CONFIG } from '../types';
import {
  detectMessageChains,
  detectSwitchStatement,
  detectRefusedBequest,
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
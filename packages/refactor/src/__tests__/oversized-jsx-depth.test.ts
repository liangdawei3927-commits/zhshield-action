import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { parseFile } from '../ast-helper';
import { detectOversizedComponent } from '../adapters/scale-detectors';
import { DEFAULT_CONFIG } from '../types';

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

describe('detectOversizedComponent (JSX 深度计量)', () => {
  it('浅 JSX + TS 泛型组件不应被误判为 oversized (TDD RED)', () => {
    const parsed = parseFile(
      path.join(FIXTURES_DIR, 'oversized-shallow-jsx.fixture.tsx'),
    );
    const smells = detectOversizedComponent(parsed, DEFAULT_CONFIG);
    expect(smells).toEqual([]);
  });

  it('兄弟组件的 JSX 深度不得在子树间泄漏 (TDD RED)', () => {
    const parsed = parseFile(
      path.join(FIXTURES_DIR, 'oversized-siblings.fixture.tsx'),
    );
    const smells = detectOversizedComponent(parsed, DEFAULT_CONFIG);
    expect(smells).toEqual([]);
  });

  it('多组件文件的组件行数须按组件粒度统计 (TDD RED)', () => {
    const parsed = parseFile(
      path.join(FIXTURES_DIR, 'oversized-multi-small.fixture.tsx'),
    );
    expect(parsed.linesOfCode).toBeGreaterThan(150);
    const smells = detectOversizedComponent(parsed, DEFAULT_CONFIG);
    expect(smells).toEqual([]);
  });

  it('单个真超大组件仍被报告，且定位到组件起始行', () => {
    const parsed = parseFile(
      path.join(FIXTURES_DIR, 'oversized-siblings.fixture.tsx'),
    );
    const tight = {
      ...DEFAULT_CONFIG,
      thresholds: { ...DEFAULT_CONFIG.thresholds, maxComponentLines: 3 },
    };
    const smells = detectOversizedComponent(parsed, tight);
    expect(smells).toHaveLength(1);
    expect(smells[0].message).toContain('组件 SiblingOne 过大');
    expect(smells[0].location.line).toBe(9); // SiblingOne 起始行（第 4 行起为 interface），而非固定第 1 行
    expect(smells[0].context.metric).toBe('componentLines');
    expect(smells[0].context.value).toBe(7); // 单组件有效行数，而非文件行数
  });
});
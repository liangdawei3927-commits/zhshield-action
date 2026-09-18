import { describe, expect, it } from 'vitest';
import { parseTsPruneOutput, parsePruneLine } from '../adapters/ts-prune-adapter';

/**
 * 🔴 回归锁定（2026-09-18）：ts-prune 输出解析曾长期静默失效。
 *
 * 原正则只认「冒号」分隔（`file:line: symbol`），而 ts-prune@0.10.x 真实输出用
 * 「破折号」分隔（`file:line - symbol`）→ 每行 parse 失败 → issues 恒为 [] →
 * tool-dispatch 判 available 且零问题 → 规则显示「工具 ts-prune 检查通过」。
 * 死代码检测因此长期零检出、永远打勾。
 *
 * 本文件用**从真机采集的原始输出行**做断言，防止再次退化为静默零检出。
 * 采集命令：`cd <ts 项目> && ts-prune -p tsconfig.json`
 */
describe('parsePruneLine — 真机输出格式', () => {
  it('解析破折号格式（ts-prune@0.10.x 实际输出）', () => {
    expect(parsePruneLine('src/orphan.ts:1 - neverImportedAnywhere')).toEqual({
      file: 'src/orphan.ts',
      line: 1,
      symbol: 'neverImportedAnywhere',
    });
  });

  it('解析冒号格式（历史/变体输出）', () => {
    expect(parsePruneLine('src/orphan.ts:12: neverImportedAnywhere')).toEqual({
      file: 'src/orphan.ts',
      line: 12,
      symbol: 'neverImportedAnywhere',
    });
  });

  it('保留带空格与括号的符号名', () => {
    expect(
      parsePruneLine('packages/desktop/src/pages/GarbagePage.tsx:16 - GarbagePage')?.symbol,
    ).toBe('GarbagePage');
  });

  it('过滤 used-in-module（该符号确有调用方，不是死代码）', () => {
    expect(parsePruneLine('vitest.shared.ts:37 - createVitestConfig (used in module)')).toBeNull();
    expect(parsePruneLine('vitest.shared.ts:37: createVitestConfig (used in module)')).toBeNull();
  });

  it('空行与非 ts-prune 输出行返回 null', () => {
    expect(parsePruneLine('')).toBeNull();
    expect(parsePruneLine('   ')).toBeNull();
    expect(parsePruneLine('error TS2307: Cannot find module')).toBeNull();
  });
});

describe('parseTsPruneOutput — 整体解析', () => {
  it('空输出 → 空数组（不得伪造条目）', () => {
    expect(parseTsPruneOutput('')).toEqual([]);
    expect(parseTsPruneOutput('\n\n')).toEqual([]);
  });

  it('多行真机输出逐行解析，噪音行被丢弃', () => {
    // 混合：真机采集的破折号行 + used-in-module 噪音 + 空白行
    const raw = [
      'src/index.ts:2 - entry',
      'src/orphan.ts:1 - neverImportedAnywhere',
      'src/orphan.ts:4 - alsoOrphaned',
      'vitest.shared.ts:37 - createVitestConfig (used in module)',
      '',
    ].join('\n');

    const parsed = parseTsPruneOutput(raw);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((p) => p.symbol)).toEqual(['entry', 'neverImportedAnywhere', 'alsoOrphaned']);
    expect(parsed[1]).toEqual({ file: 'src/orphan.ts', line: 1, symbol: 'neverImportedAnywhere' });
  });

  it('全部为 used-in-module 时 → 空数组（而非伪造通过之外的条目）', () => {
    const raw = 'a.ts:1 - x (used in module)\nb.ts:2 - y (used in module)';
    expect(parseTsPruneOutput(raw)).toEqual([]);
  });
});

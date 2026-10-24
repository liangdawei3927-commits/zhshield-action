import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  parseTsPruneOutput,
  parsePruneLine,
  filterReExportEdges,
  filterInlineImportTypeRefs,
  resolveRelativeModuleFile,
  resetReExportStatementCache,
} from '../adapters/ts-prune-adapter';

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

/**
 * 🔴 再导出边过滤（2026-10-24）
 *
 * 实测背景：本仓 desktop + shared 两包脱噪后 258 条命中里 220 条（85%）是
 * 再导出语句里的符号——符号在叶子模块内部活着，只是没人从 barrel 这个路径
 * import。旧行为下这些全部上报为「未使用的导出」，用户拿到的是噪音海。
 *
 * 本组用例守两件事，缺一不可：
 *   ① 再导出边必须被剥离（含跨 50+ 行的长块——按窗口猜测的写法会在这里漏）
 *   ② 真死代码必须仍然上报（防止「过滤太狠 → 死代码检测静默清零」）
 */
describe('filterReExportEdges — 再导出边不算死代码', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ts-prune-reexport-'));
  });

  afterEach(() => {
    resetReExportStatementCache();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, content: string): void => {
    const abs = path.join(dir, name);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  it('单行再导出 → 剥离', () => {
    put('a.ts', "export { Foo } from './foo';\n");
    const r = filterReExportEdges([{ file: 'a.ts', line: 1, symbol: 'Foo' }], dir);
    expect(r.dropped).toHaveLength(1);
    expect(r.kept).toHaveLength(0);
  });

  it('export type 再导出 → 剥离', () => {
    put('a.ts', "export type { Bar } from './bar';\n");
    const r = filterReExportEdges([{ file: 'a.ts', line: 1, symbol: 'Bar' }], dir);
    expect(r.dropped.map((e) => e.symbol)).toEqual(['Bar']);
  });

  it('跨 50+ 行的长再导出块 → 剥离（窗口猜测写法会在此漏报）', () => {
    const fillers = Array.from({ length: 55 }, (_, i) => `  Type${i},`);
    put(
      'barrel.ts',
      ['export type {', ...fillers, '  DomainDimensionScore,', "} from './types';"].join('\n'),
    );
    const symbolLine = 1 + fillers.length + 1;
    const r = filterReExportEdges(
      [{ file: 'barrel.ts', line: symbolLine, symbol: 'DomainDimensionScore' }],
      dir,
    );
    expect(r.dropped).toHaveLength(1);
  });

  it('名字对不上 → 保留（fail-open：不靠行号盲砍）', () => {
    put('a.ts', "export { Foo } from './foo';\n");
    const r = filterReExportEdges([{ file: 'a.ts', line: 1, symbol: 'NotInThatList' }], dir);
    expect(r.kept).toHaveLength(1);
  });

  it('as 别名按导出名判定：报 PublicName 剥离，报 internal 保留', () => {
    put('a.ts', "export { internal as PublicName } from './x';\n");
    const pub = filterReExportEdges([{ file: 'a.ts', line: 1, symbol: 'PublicName' }], dir);
    const inner = filterReExportEdges([{ file: 'a.ts', line: 1, symbol: 'internal' }], dir);
    expect(pub.dropped).toHaveLength(1);
    expect(inner.kept).toHaveLength(1);
  });

  it('本地再导出（无 from）不是再导出边 → 保留', () => {
    put('a.ts', 'const localA = 1;\nexport { localA };\n');
    const r = filterReExportEdges([{ file: 'a.ts', line: 2, symbol: 'localA' }], dir);
    expect(r.kept).toHaveLength(1);
  });

  it('文件读不到 → 保留（fail-open，绝不清零）', () => {
    const r = filterReExportEdges([{ file: 'missing.ts', line: 1, symbol: 'Ghost' }], dir);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('双自证：混合输入里 3 条边被剥离、2 条真死代码仍在', () => {
    put(
      'mix.ts',
      [
        "export type { A, B } from './types';",
        "export { C } from './c';",
        '',
        'export function deadOne(): number {',
        '  return 1;',
        '}',
        'export const deadTwo = 2;',
      ].join('\n'),
    );
    const r = filterReExportEdges(
      [
        { file: 'mix.ts', line: 1, symbol: 'A' },
        { file: 'mix.ts', line: 1, symbol: 'B' },
        { file: 'mix.ts', line: 2, symbol: 'C' },
        { file: 'mix.ts', line: 4, symbol: 'deadOne' },
        { file: 'mix.ts', line: 7, symbol: 'deadTwo' },
      ],
      dir,
    );
    expect(r.dropped.map((e) => e.symbol)).toEqual(['A', 'B', 'C']);
    expect(r.kept.map((e) => e.symbol)).toEqual(['deadOne', 'deadTwo']);
  });
});

/**
 * 🔴 内联 import 类型引用（`import('./m').T`）不是死代码。
 *
 * ts-prune 只统计顶层 import / export 语句形成的引用边，看不见类型位置上的
 * 内联 import。实测本仓带规则配置全仓扫描、经再导出过滤后剩 2 条，全是这一形态。
 *
 * 断言设计要点：**必须同时守住真阳性**。过滤条件精确到「解析出的绝对路径 +
 * 符号名」两者同时相等，任一不符即保留 —— 防止退化成「按符号名盲砍」。
 */
describe('filterInlineImportTypeRefs — 内联 import 类型引用不算死代码', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ts-prune-inline-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (name: string, content: string): void => {
    const abs = path.join(dir, name);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  it('内联 import 引用存在 → 剥离', () => {
    put('types.ts', 'export interface Params {\n  a: number;\n}\n');
    put('user.ts', "export function run(p: import('./types').Params): void {}\n");
    const r = filterInlineImportTypeRefs([{ file: 'types.ts', line: 1, symbol: 'Params' }], dir);
    expect(r.dropped.map((e) => e.symbol)).toEqual(['Params']);
    expect(r.kept).toHaveLength(0);
  });

  it('typeof import(...) 形态同样识别', () => {
    put('m.ts', 'export type Shape = { a: string };\n');
    put('user.ts', "type T = typeof import('./m').Shape;\n");
    const r = filterInlineImportTypeRefs([{ file: 'm.ts', line: 1, symbol: 'Shape' }], dir);
    expect(r.dropped).toHaveLength(1);
  });

  it('引用的是同文件的另一个符号 → 保留', () => {
    put('types.ts', 'export interface A {}\nexport interface B {}\n');
    put('user.ts', "type X = import('./types').B;\n");
    const r = filterInlineImportTypeRefs([{ file: 'types.ts', line: 1, symbol: 'A' }], dir);
    expect(r.kept).toHaveLength(1);
  });

  it('同名符号但引用指向别的文件 → 保留（不得按符号名盲砍）', () => {
    put('types.ts', 'export interface Params {}\n');
    put('other.ts', 'export interface Params {}\n');
    put('user.ts', "type X = import('./other').Params;\n");
    const r = filterInlineImportTypeRefs([{ file: 'types.ts', line: 1, symbol: 'Params' }], dir);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('省略扩展名的 specifier（./m → m.ts）也解析得到', () => {
    put('m.ts', 'export type T = 1;\n');
    put('user.ts', "type X = import('./m').T;\n");
    const r = filterInlineImportTypeRefs([{ file: 'm.ts', line: 1, symbol: 'T' }], dir);
    expect(r.dropped).toHaveLength(1);
  });

  it('目录索引（./types → types/index.ts）也解析得到', () => {
    put('types/index.ts', 'export type T = 1;\n');
    put('user.ts', "type X = import('./types').T;\n");
    const r = filterInlineImportTypeRefs(
      [{ file: 'types/index.ts', line: 1, symbol: 'T' }],
      dir,
    );
    expect(r.dropped).toHaveLength(1);
  });

  it('非相对 specifier（包名 / 路径别名）→ 保留（静态无法定位，fail-open）', () => {
    put('types.ts', 'export type T = 1;\n');
    put('user.ts', "type X = import('@zh/types').T;\n");
    const r = filterInlineImportTypeRefs([{ file: 'types.ts', line: 1, symbol: 'T' }], dir);
    expect(r.kept).toHaveLength(1);
  });

  it('项目根不可读 → 全部保留（fail-open，绝不清零）', () => {
    const missing = path.join(dir, 'does-not-exist');
    const r = filterInlineImportTypeRefs([{ file: 'a.ts', line: 1, symbol: 'Ghost' }], missing);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('空输入 → 空结果且不触发遍历', () => {
    expect(filterInlineImportTypeRefs([], dir)).toEqual({
      kept: [],
      dropped: [],
      degraded: false,
    });
  });

  it('双自证：1 条内联引用被剥离、2 条真死代码仍在', () => {
    put('types.ts', 'export interface Used {}\nexport interface DeadOne {}\nexport interface DeadTwo {}\n');
    put('user.ts', "type X = import('./types').Used;\n");
    const r = filterInlineImportTypeRefs(
      [
        { file: 'types.ts', line: 1, symbol: 'Used' },
        { file: 'types.ts', line: 2, symbol: 'DeadOne' },
        { file: 'types.ts', line: 3, symbol: 'DeadTwo' },
      ],
      dir,
    );
    expect(r.dropped.map((e) => e.symbol)).toEqual(['Used']);
    expect(r.kept.map((e) => e.symbol)).toEqual(['DeadOne', 'DeadTwo']);
  });

  it('node_modules / dist 内的同名引用不参与判定', () => {
    put('types.ts', 'export type T = 1;\n');
    put('node_modules/vendor/x.ts', "type X = import('../../types').T;\n");
    const r = filterInlineImportTypeRefs([{ file: 'types.ts', line: 1, symbol: 'T' }], dir);
    expect(r.kept).toHaveLength(1);
  });
});

describe('resolveRelativeModuleFile — 路径解析边界', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ts-prune-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('非相对路径一律返回 null', () => {
    expect(resolveRelativeModuleFile(path.join(dir, 'a.ts'), '@zh/shared')).toBeNull();
    expect(resolveRelativeModuleFile(path.join(dir, 'a.ts'), '/abs/path')).toBeNull();
  });

  it('相对路径不存在返回 null', () => {
    expect(resolveRelativeModuleFile(path.join(dir, 'a.ts'), './nope')).toBeNull();
  });

  it('相对路径命中返回绝对路径', () => {
    const target = path.join(dir, 'target.ts');
    writeFileSync(target, 'export const a = 1;\n');
    expect(resolveRelativeModuleFile(path.join(dir, 'user.ts'), './target')).toBe(target);
  });

  it('TypeScript 的 .js 写法解析到同名 .ts', () => {
    const target = path.join(dir, 'mod.ts');
    writeFileSync(target, 'export const a = 1;\n');
    expect(resolveRelativeModuleFile(path.join(dir, 'user.ts'), './mod.js')).toBe(target);
  });
});

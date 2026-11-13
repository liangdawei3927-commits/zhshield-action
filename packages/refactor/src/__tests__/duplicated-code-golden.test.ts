import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RefactorEngine } from '../engine';

/**
 * duplicated-code（warning 级）双自证 golden：
 * - 真阳性：两文件各含一段逐字相同的 10 行代码块（阈值 minDuplicateLines=5）→ 必报；
 * - 干净样本：逻辑相似但无逐字重复的两文件 → 必不报（防"相似即重复"误报）。
 * 与 mixed-responsibilities 门同一纪律：TP 计数打印，绿灯必须带数字。
 */

const DUPLICATED_BLOCK = [
  'function settleInvoice(record: InvoiceRecord): SettleResult {',
  '  const rate = record.region === "cn" ? 0.13 : 0.2;',
  '  const subtotal = record.amount * record.quantity;',
  '  const tax = Math.round(subtotal * rate * 100) / 100;',
  '  const total = subtotal + tax;',
  '  const stamp = Date.parse(record.issuedAt);',
  '  const payload = { total, tax, stamp };',
  '  const result = finalizeSettlement(payload);',
  '  auditLog.append("settle", payload);',
  '  return result;',
  '}',
].join('\n');

async function smellCounts(
  files: Record<string, string>,
): Promise<{ dupHits: number; scanned: number }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'dup-golden-'));
  try {
    const paths: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      writeFileSync(p, content, 'utf8');
      paths.push(p);
    }
    const engine = new RefactorEngine({ enabledRules: ['duplicated-code'] });
    const report = await engine.analyzeFiles(dir, paths);
    const dupHits = report.files.reduce(
      (sum, f) => sum + f.smells.filter((s) => s.ruleId === 'duplicated-code').length,
      0,
    );
    return { dupHits, scanned: report.scannedFiles };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('duplicated-code 规则双自证 golden', () => {
  it('真阳性：两文件逐字重复块必报（打印命中计数）', async () => {
    const { dupHits, scanned } = await smellCounts({
      'a.ts': `import { finalizeSettlement, auditLog, InvoiceRecord, SettleResult } from './lib';\n\n${DUPLICATED_BLOCK}\n`,
      'b.ts': `import { finalizeSettlement, auditLog, InvoiceRecord, SettleResult } from './lib';\n\n${DUPLICATED_BLOCK}\n`,
    });
    // 样本确被扫到（形态⑩防线）：解析数必须等于文件数
    expect(scanned).toBe(2);
    console.log(`[duplicated-code golden] 真阳性命中数: ${dupHits}`);
    // 双向去重后：一对重复只报 1 条（修复前两侧各报 1 条 = 2）
    expect(dupHits).toBe(1);
  });

  it('干净样本：逻辑相似但无逐字重复 → 0 命中', async () => {
    const { dupHits, scanned } = await smellCounts({
      'a.ts': [
        'export function sumShipping(weights: number[]): number {',
        '  let acc = 0;',
        '  for (const w of weights) {',
        '    acc += w * 2;',
        '  }',
        '  return acc;',
        '}',
      ].join('\n'),
      'b.ts': [
        'export function totalTax(rates: number[]): number {',
        '  let out = 0;',
        '  rates.forEach((r) => {',
        '    out += r + 1;',
        '  });',
        '  return out;',
        '}',
      ].join('\n'),
    });
    expect(scanned).toBe(2);
    console.log(`[duplicated-code golden] 干净样本命中数: ${dupHits}`);
    expect(dupHits).toBe(0);
  });

  /**
   * 三条滤波回归（2026-11-13，对应本仓 292 条重复区里 22 条的成因）：
   * 窗口按物理行凑数时，注释/空行/import 清单都会被当成「重复代码」。
   */
  it('纯注释窗口：同款 JSDoc 尾巴不得判为重复', async () => {
    const commentTail = [
      '/**',
      ' * 侧边栏区块组件说明（各文件首行不同）。',
      ' *',
      ' * 从 `sidebar-interactive.tsx` 按职责拆出（原文件超 400 行代码阈值）；',
      ' * 对外导出仍从 `sidebar-interactive` 统一暴露，调用方无需改动。',
      ' */',
      '',
      "import { SectionTitle } from './sidebar-common';",
    ].join('\n');
    const { dupHits, scanned } = await smellCounts({
      'a.tsx': `${commentTail}\nexport const aOnly = 1;\n`,
      'b.tsx': `${commentTail}\nexport const bOnly = 2;\n`,
    });
    expect(scanned).toBe(2);
    console.log(`[duplicated-code golden] 纯注释窗口命中数: ${dupHits}`);
    expect(dupHits).toBe(0);
  });

  it('多行导出清单：跨包 API 镜像的 export type 块不得判为重复', async () => {
    const exportBlock = [
      'export type {',
      '  DiagnosticSeverity,',
      '  DiagnosticEntry,',
      '  LspDiagnostic,',
      '  FileDiagnostics,',
      "} from './types';",
    ].join('\n');
    const { dupHits, scanned } = await smellCounts({
      'a.ts': `${exportBlock}\n\nexport const aOnly = 1;\n`,
      'b.ts': `${exportBlock}\n\nexport const bOnly = 2;\n`,
    });
    expect(scanned).toBe(2);
    console.log(`[duplicated-code golden] 导出清单命中数: ${dupHits}`);
    expect(dupHits).toBe(0);
  });

  it('有效代码不足 3 行：只剩 import + 常量时不得判为重复', async () => {
    const { dupHits, scanned } = await smellCounts({
      'a.ts': [
        "import { scorer } from './scoring';",
        '',
        '/** 置信度阈值：低于此值不输出框架判定 */',
        'const CONFIDENCE_THRESHOLD = 0.6;',
        '',
        '/** 框架聚合器 */',
        'export class FrameworkAggregator { run(): number { return CONFIDENCE_THRESHOLD * 2; } }',
      ].join('\n'),
      'b.ts': [
        "import { scorer } from './scoring';",
        '',
        '/** 置信度阈值：低于此值输出 unknown 而非硬猜 */',
        'const CONFIDENCE_THRESHOLD = 0.6;',
        '',
        '/** 语言聚合器 */',
        'export class LanguageAggregator { run(): number { return 0.5; } }',
      ].join('\n'),
    });
    expect(scanned).toBe(2);
    console.log(`[duplicated-code golden] 双语句窗口命中数: ${dupHits}`);
    expect(dupHits).toBe(0);
  });

  /**
   * 建议文案按重复区形态分流：对类型声明说「提取为公共函数」是错误建议
   * （类型该收敛到单一事实源），对常量表说「提取函数」也无从下手（该上提共享包）。
   */
  it('类型声明重复 → 提示收敛共享类型，而非提取公共函数', async () => {
    const block = [
      'export interface ProjectInfo {',
      '  name: string;',
      '  path: string;',
      '  lastOpenedAt: string;',
      '  pinned: boolean;',
      '}',
    ].join('\n');
    const dir = mkdtempSync(path.join(tmpdir(), 'dup-shape-'));
    try {
      const a = path.join(dir, 'a.ts');
      const b = path.join(dir, 'b.ts');
      writeFileSync(a, `${block}\n\nexport const aOnly = 1;\n`, 'utf8');
      writeFileSync(b, `${block}\n\nexport const bOnly = 2;\n`, 'utf8');
      const engine = new RefactorEngine({ enabledRules: ['duplicated-code'] });
      const report = await engine.analyzeFiles(dir, [a, b]);
      const smells = report.files.flatMap((f) =>
        f.smells.filter((s) => s.ruleId === 'duplicated-code'),
      );
      console.log(`[duplicated-code golden] 类型声明命中数: ${smells.length}`);
      expect(smells.length).toBe(1);
      expect(smells[0].message).toContain('收敛到共享类型定义');
      expect(smells[0].suggestion.type).toBe('Consolidate Shared Type');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

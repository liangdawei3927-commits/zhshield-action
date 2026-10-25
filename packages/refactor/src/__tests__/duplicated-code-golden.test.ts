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

async function smellCounts(files: Record<string, string>): Promise<{ dupHits: number; scanned: number }> {
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
    expect(dupHits).toBeGreaterThanOrEqual(1);
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
});

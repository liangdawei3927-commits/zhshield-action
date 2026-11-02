import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDomain } from '../domains/run-domains';
import { PipelineRunner } from '../pipeline-runner';
import type { RuleEngineReport } from '@zh/kernel';
import type { RefactorReport } from '@zh/refactor';
import type { GarbageScanReport } from '@zh/garbage';

/**
 * 《07》A3 重复代码唯一归属 —— **运行时**验收（补齐声明层的另一半）。
 *
 * 声明层（kernel `domain-boundary.test.ts`）只证明"内置规则集里没有体检域的重复规则"；
 * 本用例证明**跑起来之后**同一份重复代码只出现在重构域报告里：
 *   1. 真阳性：同一夹具上 `runDomain('refactor')` 必须报出 `duplicated-code`；
 *   2. 反证：同一夹具上体检域真实求值了规则（不是空跑），但不产出重复类结论；
 *   3. 反证：垃圾清理域真实跑了规则通道，清单与检测项里没有任何重复类条目。
 *
 * 为什么必须端到端：桌面任务的编排入口是 `runDomains` 的域执行器，
 * 只验规则声明容易漏掉"执行器自己重扫一遍"这类越界（C3 的典型破口）。
 */

const TEMPLATES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'kernel',
  'src',
  'sop',
  'presets',
  'sop-templates',
);

/** 重复的判据是 ruleId（归属身份），不扫 message 文案，避免误伤措辞 */
const DUPLICATION_TOKENS = ['duplication', 'duplicated-code', 'jscpd'];

/** 两份逐字相同的 10 行块（引擎阈值 minDuplicateLines=5），普通 TS，不触发安全/体检规则 */
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

function hasDuplicationToken(id: string): boolean {
  return DUPLICATION_TOKENS.some((token) => id.includes(token));
}

describe('《07》A3 — 重复代码唯一归重构（运行时）', () => {
  let fixture: string;
  let runner: PipelineRunner;

  beforeAll(async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-domain-boundary-'));
    for (const name of ['a.ts', 'b.ts']) {
      fs.writeFileSync(path.join(fixture, name), `${DUPLICATED_BLOCK}\n`, 'utf8');
    }
    // 真实装配：规则集来自内置模板，适配器由 PipelineRunner 注册（不手搓 runner 桩）
    runner = new PipelineRunner(fixture, { configDir: TEMPLATES_DIR });
    await runner.loadSopRules();
  }, 60_000);

  afterAll(async () => {
    await runner.destroy();
    fs.rmSync(fixture, { recursive: true, force: true });
  });

  it('重构域：同一份重复代码在夹具有产出（真阳性）', async () => {
    const record = await runDomain('refactor', { repoRoot: fixture, budgets: { refactor: 60_000 } });

    expect(record.status).toBe('ok');
    const report = record.report as RefactorReport;
    expect(report).toBeDefined();

    const dupSmells = report.files
      .flatMap((file) => file.smells)
      .filter((smell) => smell.ruleId === 'duplicated-code');
    // 双向去重后一对重复只报 1 条；这里只锁"有产出"，具体条数归 refactor 包自己的 golden
    expect(dupSmells.length).toBeGreaterThan(0);
  });

  it('体检域：真实求值规则但不产出重复类结论（反证）', async () => {
    const record = await runDomain('inspect', {
      repoRoot: fixture,
      runner,
      budgets: { inspect: 90_000 },
    });

    // 不是 unavailable（规则确实装载并求值了），允许 partial（个别工具不可用）
    expect(['ok', 'partial']).toContain(record.status);
    const report = record.report as RuleEngineReport;
    expect(report.total).toBeGreaterThan(0);

    // 防空跑：至少有一条评估给出了 passed / failed 结论，证明真的读了夹具
    const evaluated = report.evaluations.filter(
      (evaluation) => evaluation.status === 'passed' || evaluation.status === 'failed',
    );
    expect(evaluated.length).toBeGreaterThan(0);

    // C1：体检域只跑体检规则
    expect(report.evaluations.every((evaluation) => evaluation.rule.domain === 'inspect')).toBe(true);

    // A3：任何一条规则（含其违规明细）都不得是重复代码类
    const offenders = report.evaluations
      .flatMap((evaluation) => [
        evaluation.rule.id,
        ...(evaluation.violations ?? []).map((violation) => violation.ruleId),
      ])
      .filter(hasDuplicationToken);
    expect(offenders).toEqual([]);
  });

  it('垃圾清理域：规则通道真跑，但清单/检测项无重复类条目（反证）', async () => {
    const record = await runDomain('garbage', {
      repoRoot: fixture,
      runner,
      budgets: { garbage: 45_000 },
    });

    expect(['ok', 'partial']).toContain(record.status);
    expect(record.detail?.ruleChannelRan).toBe(true);
    const report = record.report as GarbageScanReport;
    expect(report).toBeDefined();

    // A3：重复代码明细归重构域；垃圾域无论文件系统检测还是规则通道都不得登记它
    const offenders = [...report.checks.map((check) => check.ruleId), ...report.items.map((item) => item.type)]
      .filter(hasDuplicationToken);
    expect(offenders).toEqual([]);
  });
});

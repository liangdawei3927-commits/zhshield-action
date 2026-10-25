/**
 * error 级规则双自证 golden（2026-10-25）。
 *
 * 背景：refactor 引擎的 20+ 检测器长期没有 golden 集不在双自证门内，而其中
 * 三条是 error 级（会阻断用户提交）：large-class / god-object / inappropriate-intimacy。
 * error 级误报的代价最高（拦住合法提交），漏报的代价是规则名存实亡。
 *
 * 每条规则两道自证（缺一不可，参照 kernel rule-quality-gate 的口径）：
 * ① 真阳性必报 —— 合成踩线样本，断言命中数 ≥1 并打印计数（防"样本没进扫描"的假绿）；
 * ② 干净样本必不报 —— 合成合规样本，断言命中数 = 0（防"为修假通过换来误报机器"）。
 *
 * 样本放 os.tmpdir()：detectors 对 /__tests__/ 与 /fixtures/ 路径有豁免启发式
 * （detector-heuristics.isTestFixture），样本留在测试目录里会被被测对象自己排除（形态⑩）。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RefactorEngine } from '../engine';

/** 单方法 4 行的最小方法体，用于凑方法数 */
function method(name: string): string {
  return `  ${name}(x: number): number {
    return x + 1;
  }
`;
}

/** TP：21 个公共方法（阈值 20）→ large-class（方法数超限）与 god-object（公共方法数超限）都应命中 */
const GOD_CLASS_SAMPLE = `export class OrderOrchestrator {
${Array.from({ length: 21 }, (_, i) => method(`step${i + 1}`)).join('\n')}
}
`;

/** TP：4 个公共字段（阈值 3）→ inappropriate-intimacy 应命中 */
const PUBLIC_FIELDS_SAMPLE = `export class SessionContext {
  public userId: string = '';
  public tenantId: string = '';
  public token: string = '';
  public locale: string = '';
}
`;

/** 干净样本：小类，2 个方法 + 2 个公共字段，任何一条 error 规则都不该报 */
const CLEAN_SAMPLE = `export class MoneyFormatter {
  public currency: string = 'CNY';
  public symbol: string = '¥';

  format(amount: number): string {
    return this.symbol + amount.toFixed(2);
  }

  parse(text: string): number {
    return Number(text.replace(this.symbol, ''));
  }
}
`;

async function countHits(ruleId: string, sample: string, tag: string): Promise<number> {
  const dir = mkdtempSync(path.join(tmpdir(), `${tag}-`));
  try {
    const file = path.join(dir, 'sample.ts');
    writeFileSync(file, sample, 'utf8');
    const engine = new RefactorEngine({ enabledRules: [ruleId] });
    const report = await engine.analyzeFiles(dir, [file]);
    return report.files.reduce(
      (sum, f) => sum + f.smells.filter((s) => s.ruleId === ruleId).length,
      0,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('error 级规则双自证 golden', () => {
  it(
    'large-class：21 方法类必报，干净小类必不报',
    async () => {
      const tp = await countHits('large-class', GOD_CLASS_SAMPLE, 'gate-large-class-tp');
      console.log(`[large-class golden] 真阳性命中数: ${tp}`);
      expect(tp).toBeGreaterThanOrEqual(1);

      const fp = await countHits('large-class', CLEAN_SAMPLE, 'gate-large-class-clean');
      expect(fp).toBe(0);
    },
    30_000,
  );

  it(
    'god-object：21 个公共方法必报，干净小类必不报',
    async () => {
      const tp = await countHits('god-object', GOD_CLASS_SAMPLE, 'gate-god-object-tp');
      console.log(`[god-object golden] 真阳性命中数: ${tp}`);
      expect(tp).toBeGreaterThanOrEqual(1);

      const fp = await countHits('god-object', CLEAN_SAMPLE, 'gate-god-object-clean');
      expect(fp).toBe(0);
    },
    30_000,
  );

  it(
    'inappropriate-intimacy：4 个公共字段必报，3 个以内必不报',
    async () => {
      const tp = await countHits(
        'inappropriate-intimacy',
        PUBLIC_FIELDS_SAMPLE,
        'gate-intimacy-tp',
      );
      console.log(`[inappropriate-intimacy golden] 真阳性命中数: ${tp}`);
      expect(tp).toBeGreaterThanOrEqual(1);

      const fp = await countHits('inappropriate-intimacy', CLEAN_SAMPLE, 'gate-intimacy-clean');
      expect(fp).toBe(0);
    },
    30_000,
  );
});

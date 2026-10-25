/**
 * mixed-responsibilities 规则质量门（2026-10-25）。
 *
 * 背景：该规则的"职责数" = 注释分区数 + 空行块数 + try 个数（纯字面量代理，
 * 见 structure-detectors.ts countResponsibilities），与真实职责无关。
 * 对本项目自身代码实测 32 处命中 0 处可用（22 行的 useHealthOverview 被判
 * 4 个职责；RefactorPage 已拆成 5 个 hook + 4 个子组件仍被判 14 个），
 * 精确率 0%。核实报告：仓库根《智汇码盾混合职责规则核实报告-2026-10-25.html》。
 *
 * 处置：默认下线（DEFAULT_CONFIG.enabledRules 移除）。本测试三道自证：
 * ① 下线状态锁定 —— 有人把它加回默认清单而未重写检测器时，这里红；
 * ② 判据会红 + 样本确被扫到（形态⑩负向自证）—— 显式启用时误报回归集必须
 *    产生命中（>0），证明扫描真的覆盖了这些文件、门禁不是假绿；
 * ③ 真阳性 golden —— 合成的真·多职责函数必须报，检测器代码路径不因下线而烂掉。
 *
 * 重写验收标准：检测器换成语义信号后，先让②的命中数归零（回归集全清），
 * 再恢复默认启用，并同步更新本文件注释。
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RefactorEngine } from '../engine';
import { DEFAULT_CONFIG } from '../types';

const RULE_ID = 'mixed-responsibilities';

/** 仓库根（__tests__ → src → packages/refactor → packages → 仓库根） */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/**
 * 误报回归集（golden FP corpus，2026-10-25 逐行核实）。
 * 这些文件结构健康：页面组件是 hooks → 派生 → 渲染分支，纯函数是直线映射。
 * 任何版本的检测器，对这批文件的期望命中数都是 0 —— 这是恢复默认启用的前置条件。
 * 路径相对仓库根；文件移动时同步更新此清单（测试会对存在性失败）。
 */
const FP_CORPUS: readonly string[] = [
  'packages/desktop/src/components/layout/global-scan-indicator.tsx',
  'packages/desktop/src/hooks/useHealthOverview.ts',
  'packages/desktop/src/pages/PerformancePage.tsx',
  'packages/desktop/src/pages/BackupPage.tsx',
  'packages/desktop/src/hooks/useSavedDomainReport.ts',
  'packages/desktop/src/pages/RefactorPage.tsx',
  'packages/desktop/src/pages/category-score-cards.tsx',
  'packages/desktop/src/hooks/useDomainDetailEntry.ts',
  'packages/desktop/src/pages/inspect-snapshot-mapper.ts',
  'packages/desktop/electron/zhshield-mcp.ts',
  'packages/desktop/src/components/business/DomainSnapshotReport.tsx',
  'packages/security/src/adapters/trivy-adapter.ts',
  'packages/desktop/src/pages/DependencyPage.tsx',
  'packages/desktop/src/pages/domain-snapshot-logic.ts',
  'packages/desktop/src/components/layout/sidebar-status.tsx',
  'packages/inspect/src/adapters/ts-prune-adapter-core.ts',
  'packages/desktop/src/pages/report-attribution.ts',
  'packages/desktop/src/pages/GarbagePage.tsx',
  'packages/pipeline/src/project-profile.ts',
  'packages/desktop/electron/ipc/engines.ts',
  'packages/desktop/src/pages/TechDebtPage.tsx',
  'packages/desktop/src/pages/SentinelPage.tsx',
  'packages/desktop/src/pages/report-windows.ts',
  'packages/desktop/electron/domain-history.ts',
  'packages/desktop/src/pages/report-attribution-parts.tsx',
  'packages/desktop/src/app-logic.ts',
  'packages/desktop/src/pages/SecurityPage.tsx',
  'packages/desktop/src/pages/GuardPage.tsx',
  'packages/desktop/src/pages/InspectPage.tsx',
];

/** 真阳性 golden：单函数内真实地混合了读文件 / 校验 / 转换 / 写盘四类职责 */
const TRUE_POSITIVE_SAMPLE = `import * as fs from 'fs';

export function processOrderFile(orderPath: string): string {
  // Step 1: read raw order from disk
  const raw = fs.readFileSync(orderPath, 'utf8');

  // Step 2: validate the payload shape
  try {
    JSON.parse(raw);
  } catch {
    return 'invalid';
  }

  // Step 3: transform into the normalized export form
  const normalized = raw.trim().split('\\n').map((l) => l.trim()).join('|');

  // Step 4: persist the result next to the source
  try {
    fs.writeFileSync(orderPath + '.out', normalized, 'utf8');
  } catch {
    return 'write-failed';
  }
  return 'ok';
}
`;

/** 用显式启用该规则的引擎扫描给定文件，返回该规则命中数与实际解析数 */
async function scanWithRule(files: readonly string[]): Promise<{ hits: number; scanned: number }> {
  const engine = new RefactorEngine({ enabledRules: [RULE_ID] });
  const abs = files.map((f) => (path.isAbsolute(f) ? f : path.join(REPO_ROOT, f)));
  const report = await engine.analyzeFiles(REPO_ROOT, abs);
  const hits = report.files.reduce(
    (sum, f) => sum + f.smells.filter((s) => s.ruleId === RULE_ID).length,
    0,
  );
  return { hits, scanned: report.scannedFiles };
}

/** 默认配置（规则已下线）扫描，返回该规则命中数 */
async function countHitsDefault(files: readonly string[]): Promise<number> {
  const engine = new RefactorEngine();
  const abs = files.map((f) => (path.isAbsolute(f) ? f : path.join(REPO_ROOT, f)));
  const report = await engine.analyzeFiles(REPO_ROOT, abs);
  return report.files.reduce(
    (sum, f) => sum + f.smells.filter((s) => s.ruleId === RULE_ID).length,
    0,
  );
}

describe('mixed-responsibilities 规则质量门', () => {
  it('默认配置不启用 mixed-responsibilities（下线状态锁定）', () => {
    expect(DEFAULT_CONFIG.enabledRules).not.toContain(RULE_ID);
  });

  it('误报回归集文件全部存在（防样本漂移导致假绿）', () => {
    const missing = FP_CORPUS.filter((rel) => !existsSync(path.join(REPO_ROOT, rel)));
    expect(missing).toEqual([]);
  });

  it('默认引擎对误报回归集产出 0 条命中', async () => {
    const hits = await countHitsDefault(FP_CORPUS);
    expect(hits).toBe(0);
  });

  it('负向自证：显式启用时回归集必产生命中（判据确会红、样本确被扫到）', async () => {
    const { hits, scanned } = await scanWithRule(FP_CORPUS);
    // 样本确被扫到：解析数必须等于清单数（parseFile 按 cwd 解析相对路径，
    // 传相对路径会在 vitest 下全部静默跳过 —— 已实测，故此处必须传绝对路径）
    expect(scanned).toBe(FP_CORPUS.length);
    // 打印真阳性计数：绿灯必须带数字，防止"0 命中却判通过"的形态⑩假绿
    console.log(`[mixed-resp gate] 回归集显式启用命中数（当前未重写检测器的已知误报）: ${hits}`);
    expect(hits).toBeGreaterThan(0);
  });

  it('真阳性 golden：多职责合成函数必报（检测器代码路径未被下线破坏）', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mixed-resp-gate-'));
    try {
      const file = path.join(dir, 'process-order.ts');
      writeFileSync(file, TRUE_POSITIVE_SAMPLE, 'utf8');
      const { hits, scanned } = await scanWithRule([file]);
      expect(scanned).toBe(1);
      console.log(`[mixed-resp gate] 真阳性样本命中数: ${hits}`);
      expect(hits).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * 复现「垃圾清理页 → 复制到AI」的完整产出：
 *   1. detectFsGarbage 文件系统检测（构建产物/垃圾文件/空文件）
 *   2. garbage 域 SOP 规则（ts-prune 死代码 / jscpd 重复代码 / depcheck 未用依赖）+ 云同步规则
 *   3. buildGarbageReport 合并
 *   4. 与页面 copyAllToAi 相同的 buildAiFixPrompt 格式化（写文件，不刷屏）
 *
 * 产物：
 *   <out>/garbage-report.json      GarbageScanReport 全量 JSON
 *   <out>/ai-check-prompt.txt      复制到AI的提示词全文（与页面按钮一致）
 *   <out>/items-summary.json       按 type/size 汇总
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { initI18n, resolveLanguage, t } from '@zh/i18n';
import { detectFsGarbage, buildGarbageReport } from '@zh/garbage';
import { buildAiFixPrompt } from '../src/utils/copyToAi';

initI18n({ lng: resolveLanguage(process.env.LNG ?? null, null).value });

/** 与 garbage-logic.ts CLEANABLE_TYPES 保持同源：可勾选清理的垃圾类型 */
const CLEANABLE_TYPES: ReadonlySet<string> = new Set([
  'unused-file',
  'dead-code',
  'duplicate-code',
  'build-artifact',
]);

const projectPath = process.argv[2] ?? process.cwd();
const outDir = process.argv[3] ?? '/tmp/zh-garbage-repro';
fs.mkdirSync(outDir, { recursive: true });

async function main(): Promise<void> {
  const started = Date.now();

  // ── ① 文件系统检测器 ──────────────────────────────
  const fsItems = await detectFsGarbage(projectPath);

  // ── ② garbage 域 SOP 规则通道 ─────────────────────
  type GarbageInput = Parameters<typeof buildGarbageReport>[0];
  let evaluations: GarbageInput['evaluations'] = [];
  let ruleChannelRan = false;
  try {
    const { PipelineRunner } = await import('@zh/pipeline');
    const runner = new PipelineRunner(projectPath);
    await runner.loadSopRules();
    const cacheDir = process.env.ZH_SOP_CACHE_DIR;
    if (cacheDir) {
      const synced = await runner.loadSopRulesFromCache(cacheDir);
      console.log(`[repro] 云同步规则合并: ${synced} 条`);
    }
    const sopReport = await runner.runSopInspect({ domains: ['garbage'] });
    evaluations = (sopReport.evaluations ?? []) as GarbageInput['evaluations'];
    ruleChannelRan = true;
  } catch (err) {
    console.warn(
      '[repro] 垃圾规则通道异常，降级为仅文件系统检测:',
      err instanceof Error ? err.message : String(err),
    );
  }

  // ── ③ 合并报告 ───────────────────────────────────
  const report = buildGarbageReport({ projectPath, fsItems, evaluations, ruleChannelRan });
  fs.writeFileSync(
    path.join(outDir, 'garbage-report.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );

  // ── ④ 与页面 copyAllToAi 相同的 issue 映射 + buildAiFixPrompt ──
  const sourceLabel = t('page.garbage.source');
  const cleanableLabel = t('page.garbage.cleanableLabel');
  const manualLabel = t('page.garbage.manualLabel');
  const safetySuggestion = t('page.garbage.safetySuggestion');
  const items = report.items;
  const issues = items.map((g) => ({
    source: sourceLabel,
    ruleId: g.type,
    file: g.path,
    severity: CLEANABLE_TYPES.has(g.type) ? cleanableLabel : manualLabel,
    message: g.reason || g.path,
    suggestion: safetySuggestion,
    domain: 'garbage',
  }));
  const text = buildAiFixPrompt(projectPath, issues);
  fs.writeFileSync(path.join(outDir, 'ai-check-prompt.txt'), text, 'utf-8');

  // ── ⑤ 汇总 ───────────────────────────────────────
  const byType = report.summary.byType;
  const sizeByType: Record<string, number> = {};
  for (const g of items) sizeByType[g.type] = (sizeByType[g.type] ?? 0) + (g.size || 0);
  const cleanableCount = items.filter((g) => CLEANABLE_TYPES.has(g.type)).length;
  const summary = {
    projectPath,
    timestamp: report.timestamp,
    total: report.summary.total,
    totalSizeBytes: report.summary.size,
    cleanableCount,
    manualCount: items.length - cleanableCount,
    byType,
    sizeByType,
    checks: report.checks,
    skipped: report.skipped,
    ruleChannelRan,
    toolCount: evaluations.length,
    durationMs: Date.now() - started,
  };
  fs.writeFileSync(path.join(outDir, 'items-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n[repro] 产出目录: ${outDir}`);
}

void main();
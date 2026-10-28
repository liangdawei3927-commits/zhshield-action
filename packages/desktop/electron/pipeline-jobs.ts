/**
 * 单引擎任务执行
 *
 * 独立的「重构 / 门禁 / 安全 / 垃圾清理 / 性能」任务，由子进程消息路由分发，
 * 每个任务创建对应引擎并在完成后发送结果消息。
 *
 * 注：巡检（inspect）与门禁（guard）的**规则集口径**统一后，本文件不再自建引擎，
 * 一律经 `createLoadedRunner` 装配（见 pipeline-runner-factory 的说明）。
 * 巡检单引擎通道（runInspectJob）已移除——渲染层无调用方，巡检页走 SOP 流水线、
 * MCP 走 CLI，保留它只会制造第三份规则集。
 */
import { t } from '@zh/i18n';
import { serializePipelineReport } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import { createLoadedRunner } from './pipeline-runner-factory';
import type { PerformanceReportIssue } from './pipeline-report';
import type { CheckOptions } from '@zh/guard';
import type { GarbageEvaluationLike, GarbageScanReport } from '@zh/garbage';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  appendDomainHistory,
  buildRecordFromFingerprints,
  normalizeFingerprint,
} from './domain-history';
import { computeDomainSnapshotScore } from './domain-snapshot-score';

/** garbage 快照串行化写入队列：并发并发多轮扫描时避免 writeFile 交错覆盖（对齐 dashboard-state writeQueue 模式） */
let garbageSnapshotQueue: Promise<void> = Promise.resolve();

export async function runRefactorJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'refactor', t('pipeline.refactor.collecting'), 0.05);
  const { RefactorEngine, applyRefactorBaseline } = await import('@zh/refactor');
  const { loadRefactorBaseline } = await import('@zh/shared');
  const engine = new RefactorEngine();
  try {
    progress(id, 'refactor', t('pipeline.refactor.analyzing'), 0.2);
    const report = await engine.analyzeDirectory(projectPath);
    // 棘轮基线：.zhshield/refactor-baseline.json 存在时只报增量；无基线全量（历史行为）
    const baselineCounts = await loadRefactorBaseline(projectPath);
    const filtered = baselineCounts
      ? applyRefactorBaseline(report, baselineCounts, projectPath)
      : null;
    const finalReport = filtered ? filtered.report : report;
    const note =
      filtered && filtered.suppressedCount > 0
        ? t('pipeline.refactor.baselineSuppressed', { count: filtered.suppressedCount })
        : '';
    progress(
      id,
      'done',
      t('pipeline.refactor.done', { count: finalReport.totalSmells }) + note,
      1.0,
    );
    send({ type: 'result', id, report: serializePipelineReport(finalReport) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[pipeline-worker] 重构分析异常:',
      err instanceof Error ? err.stack || message : message,
    );
    send({ type: 'error', id, error: message });
  }
}

/**
 * 门禁任务 — 规则集与流水线门禁阶段**同源**（T13 口径统一）。
 *
 * 此前本函数自建 GuardEngine 并自行注册 6 个适配器，但**没有** `useSopEngine` 连线，
 * 于是 `GuardEngine.run()` 走 runTraditional 分支读 `guard/config/checks.json`
 * （4 项：ARCH-001 / LINT-001 / TEST-001 / SEC-001），而体检流水线的门禁阶段走
 * SOP 门禁规则 —— 同一个「门禁」两个规则集，页面点与流水线跑的条目数、结论都不一致。
 *
 * 现改为经 `createLoadedRunner` 装配：runner 内部已完成 `useSopEngine` 连线与
 * 适配器注册，`runGuard` 因此与流水线门禁阶段执行完全相同的 SOP 规则集。
 *
 * 已知缺口（不掩盖）：SOP 门禁域当前无「测试运行」规则，checks.json 时代的 TEST-001
 * 因此不再出现在门禁页。补该规则需要新增 ToolAdapter（ToolId 枚举 + tools.json），
 * 属独立立项，见交付说明遗留项。
 */
export async function runGuardJob(
  id: string,
  projectPath: string,
  options?: Record<string, unknown>,
): Promise<void> {
  progress(id, 'guard', t('pipeline.guard.jobScanning'), 0.1);
  const { runner, syncedRules } = await createLoadedRunner(projectPath);
  if (syncedRules > 0) {
    progress(id, 'guard', `同步规则已加载 ${syncedRules} 条`, 0.15);
  }
  try {
    const report = await runner.runGuard({
      mode: 'guard',
      target: projectPath,
      ...(options ?? {}),
    } as Partial<CheckOptions>);
    progress(id, 'done', t('pipeline.guard.jobDone'), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 门禁扫描异常:', message);
    send({ type: 'error', id, error: message });
  } finally {
    await runner.destroy().catch(() => undefined);
  }
}

export async function runSecurityJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'security', t('pipeline.security.scanning'), 0.1);
  const { SecurityEngine } = await import('@zh/security');
  // P1-A：引擎事件接通 worker progress 通道。此前 emit 为 noop、事件全被丢弃，
  // 5 分钟安全扫描全程只有开头一条 10% → 用户毫无进度感、"一下跳 100"。
  // 编排器串行跑 4 个外部工具（trivy/grype/depcheck/semgrep）：
  // 每个工具开始/完成各上报一次，步进覆盖 10%→90%（步长 0.2 与默认 4 工具对齐）。
  let toolsDone = 0;
  const engine = new SecurityEngine({
    emit: (event) => {
      if (event.type === 'tool:scan-started') {
        progress(
          id,
          'security',
          t('pipeline.security.toolRunning', { tool: event.payload.tool }),
          Math.min(0.9, 0.1 + toolsDone * 0.2),
        );
        return;
      }
      if (event.type === 'tool:executed') {
        toolsDone += 1;
        progress(
          id,
          'security',
          t('pipeline.security.toolDone', {
            tool: event.payload.tool,
            count: event.payload.issueCount,
          }),
          Math.min(0.9, 0.1 + toolsDone * 0.2),
        );
      }
    },
  });
  engine.registerDefaultAdapters();
  try {
    const report = await engine.runSecurityScan(projectPath, projectPath);
    progress(id, 'done', t('pipeline.security.done'), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 安全扫描异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 垃圾清理扫描 — 垃圾清理域自有通道（T5 各司其职）。
 *
 * 组成两条来源，合并为一份 GarbageScanReport：
 *   ① 文件系统检测器（@zh/garbage detectFsGarbage）：构建产物 / 垃圾文件 / 空文件
 *   ② garbage 域 SOP 规则：死代码（ts-prune）/ 重复代码（jscpd）/ 未用依赖（depcheck）
 *
 * 不再调用安全引擎：此前为取 report.garbage 一个字段而完整跑一遍 11 工具安全扫描，
 * 属跨域借调触发权。规则通道异常不阻断，报告 checks 会带 ruleChannelRan=false 显式留痕。
 */
export async function runGarbageScanJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.scanning'), 0.1);
  try {
    const { detectFsGarbage, buildGarbageReport } = await import('@zh/garbage');
    const fsItems = await detectFsGarbage(projectPath);
    const { evaluations, ruleChannelRan } = await runGarbageRuleChannel(id, projectPath);
    const report = buildGarbageReport({ projectPath, fsItems, evaluations, ruleChannelRan });
    await writeGarbageSnapshot(projectPath, report);
    progress(id, 'done', t('pipeline.garbage.scanDone', { count: report.summary.total }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 垃圾扫描异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/** ② garbage 域 SOP 规则通道：只评估 garbage 域（ts-prune / jscpd / depcheck），异常降级不阻断 */
async function runGarbageRuleChannel(
  id: string,
  projectPath: string,
): Promise<{ evaluations: GarbageEvaluationLike[]; ruleChannelRan: boolean }> {
  let evaluations: GarbageEvaluationLike[] = [];
  let ruleChannelRan = false;
  try {
    const { PipelineRunner } = await import('@zh/pipeline');
    const runner = new PipelineRunner(projectPath);
    await runner.loadSopRules();
    progress(id, 'garbage', t('pipeline.garbage.ruleScanning'), 0.5);
    const sopReport = await runner.runSopInspect({ domains: ['garbage'] });
    evaluations = sopReport.evaluations ?? [];
    ruleChannelRan = true;
  } catch (err) {
    console.warn(
      '[pipeline-worker] 垃圾规则通道异常，降级为仅文件系统检测:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return { evaluations, ruleChannelRan };
}

/** 全量快照落盘：与 inspect/guard 等域一致，写入 .zhshield/diagnostics/domains/garbage.json；失败静默降级 */
async function writeGarbageSnapshot(projectPath: string, report: GarbageScanReport): Promise<void> {
  try {
    garbageSnapshotQueue = garbageSnapshotQueue.then(async () => {
      const dir = join(projectPath, '.zhshield', 'diagnostics', 'domains');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'garbage.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
      await appendGarbageHistory(projectPath, report);
    });
    await garbageSnapshotQueue;
  } catch (err) {
    console.warn(
      '[pipeline-worker] garbage 快照落盘失败（扫描结果仍照常上报）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * 垃圾清理的域级历史。
 *
 * 为什么单独一条路径：garbage 不走 `writeDomainSnapshots`（它的快照结构是
 * `items/checks/skipped`，不是归一化诊断条目），但同样需要「每次一条」的历史，
 * 否则一天扫 10 次只剩最后 30 条死代码，看不出增减。
 *
 * 指纹用 `类型 + 相对路径`（不含 reason）：reason 文案可能随规则更新变化，
 * 把文案算进指纹会让同一处垃圾每次都「新增 + 消失」各一次。
 * 该域没有 severity 概念 → `severityApplicable: false`，不用 0 冒充「都是 info」。
 */
async function appendGarbageHistory(
  projectPath: string,
  report: GarbageScanReport,
): Promise<void> {
  try {
    const fingerprints = report.items.map(
      (item) => `garbage:${item.type}:${normalizeFingerprint(item.path, projectPath)}`,
    );
    const ranChecks = report.checks.filter((check) => check.ran).length;
    // P2：garbage 域当场出分（garbagePenalty({total, byType})，与 dashboard-state patch
    // 同源同形；compose-on-read 同口径）。该域无 severity 概念，条目不参与计分。
    const dimensionScore = computeDomainSnapshotScore({
      dimension: 'garbage',
      garbage: { total: report.summary.total, byType: report.summary.byType },
    });
    await appendDomainHistory(
      projectPath,
      buildRecordFromFingerprints({
        domain: 'garbage',
        scannedAt: report.timestamp,
        recordedAt: new Date().toISOString(),
        fingerprints,
        total: report.summary.total,
        score: dimensionScore?.score ?? null,
        ...(dimensionScore?.version === undefined
          ? {}
          : { scoreVersion: dimensionScore.version }),
        severityApplicable: false,
        coverage: { files: ranChecks, skipped: report.skipped },
      }),
    );
  } catch (err) {
    console.warn(
      '[pipeline-worker] garbage 历史写入失败（快照已落盘）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function runGarbageCleanJob(
  id: string,
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.cleaning'), 0.1);
  const { cleanGarbage } = await import('@zh/garbage');
  try {
    const result = cleanGarbage(projectPath, items);
    progress(id, 'done', t('pipeline.garbage.done', { count: result.cleaned.length }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 垃圾清理异常:', message);
    send({ type: 'error', id, error: message });
  }
}

export async function runGarbageRestoreJob(
  id: string,
  projectPath: string,
  batchId: string,
): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.restoring'), 0.1);
  const { restoreGarbage } = await import('@zh/garbage');
  try {
    const result = restoreGarbage(projectPath, batchId);
    progress(id, 'done', t('pipeline.garbage.restoreDone', { count: result.restored }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(result) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 垃圾恢复异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 性能优化检测 — 性能页自有引擎单通道（@zh/performance）。
 *
 * 历史（T7 去越界）：本任务曾并跑一条「inspect 域 SOP 通道」，注释声称覆盖
 * ESLint 性能规则集 + Semgrep ReDoS。但生产 presets 中**不存在**
 * `category: performance` 的规则 —— ESLint 性能配置（kernel/assets/eslint/
 * eslint-performance.config.mjs）与 Semgrep ReDoS 规则只挂在 kernel assets
 * 与 test-fixtures，由 zhcheck / guard 路径消费。该通道因此恒产出 0 条，
 * 却要跑完整个 inspect 域（借调他域且零收益），已移除。
 *
 * 若后续要覆盖运行时反模式，应作为 @zh/performance 自有探测器落地
 * （走 ToolAdapter 共享能力），而不是回到 inspect 域 SOP 借调。
 *
 * 引擎异常不再降级吞掉：单通道下吞异常等同于把「没查到」显示成「没问题」，
 * 故直接抛出由外层转 error 事件。
 */
export async function runPerformanceJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'performance', t('pipeline.performance.loadingRules'), 0.1);
  try {
    const startedAt = Date.now();
    // 纯静态分析，不执行项目代码（P0-2 禁令）
    const { PerformanceEngine } = await import('@zh/performance');
    const engineReport = new PerformanceEngine().scan(projectPath);
    progress(id, 'performance', t('pipeline.performance.scanning'), 0.6);
    const issues: PerformanceReportIssue[] = dedupePerformanceIssues(
      engineReport.issues.map((issue) => ({
        id: issue.id,
        ruleId: issue.ruleId,
        severity: issue.severity,
        file: issue.file,
        line: issue.line,
        message: issue.message,
        suggestion: issue.suggestion,
        autoFixable: issue.autoFixable,
      })),
    );
    const report = {
      summary: {
        total: issues.length,
        autoFixable: issues.filter((i) => i.autoFixable).length,
      },
      issues,
      metadata: {
        duration: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      },
    };
    progress(id, 'done', t('pipeline.performance.done', { count: issues.length }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 性能检测异常:', message);
    send({ type: 'error', id, error: message });
  }
}

/**
 * 按 issue.id 去重（引擎 id 已含 file + 具体维度，如
 * `complexity-sync-io-{file}-{fnName}`）。
 *
 * 旧实现按 `ruleId:file` 去重 —— 那是双通道合并期的产物，单通道后只会**少报**：
 * 同一文件里 readFileSync 与 execSync 是两条独立问题，ruleId 同为
 * `complexity.sync-io`、file 相同 → 被压成 1 条。
 */
function dedupePerformanceIssues(issues: PerformanceReportIssue[]): PerformanceReportIssue[] {
  const seen = new Set<string>();
  const result: PerformanceReportIssue[] = [];
  for (const issue of issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    result.push(issue);
  }
  return result;
}

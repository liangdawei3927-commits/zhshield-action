/**
 * 单引擎任务执行
 *
 * 独立的「重构 / 门禁 / 巡检 / 安全 / 性能」任务，由子进程消息路由分发，
 * 每个任务创建对应引擎并在完成后发送结果消息。
 */
import { t } from '@zh/i18n';
import { serializePipelineReport } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import type { PerformanceReportIssue } from './pipeline-report';
import type { CheckOptions } from '@zh/guard';
// 直连纯内存缓存模块而非 ipc-context：本文件被打进 pipeline-worker 子进程
// bundle，ipc-context 顶层 electron 副作用（app.isPackaged 等）在 fork
// （ELECTRON_RUN_AS_NODE=1）中加载即崩溃。
import { getCachedProfile } from './profile-cache';

export async function runRefactorJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'refactor', t('pipeline.refactor.collecting'), 0.05);
  const { RefactorEngine } = await import('@zh/refactor');
  const engine = new RefactorEngine();
  try {
    progress(id, 'refactor', t('pipeline.refactor.analyzing'), 0.2);
    const report = await engine.analyzeDirectory(projectPath);
    progress(id, 'done', t('pipeline.refactor.done', { count: report.totalSmells }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      '[pipeline-worker] 重构分析异常:',
      err instanceof Error ? err.stack || message : message,
    );
    send({ type: 'error', id, error: message });
  }
}

export async function runGuardJob(
  id: string,
  projectPath: string,
  options?: Record<string, unknown>,
): Promise<void> {
  progress(id, 'guard', t('pipeline.guard.jobScanning'), 0.1);
  const {
    GuardEngine,
    GuardESLintCheckAdapter,
    GuardSensitiveInfoAdapter,
    FileSecretStateLookup,
    ArchitectureBoundaryAdapter,
    TestRunnerAdapter,
    SecurityScanAdapter,
    GuardTrivyAdapter,
  } = await import('@zh/guard');
  const engine = new GuardEngine(projectPath, undefined, { emit: () => undefined });
  engine.registerAdapter('eslint-check', new GuardESLintCheckAdapter());
  engine.registerAdapter(
    'sensitive-info',
    new GuardSensitiveInfoAdapter(new FileSecretStateLookup()),
  );
  engine.registerAdapter('architecture-boundary', new ArchitectureBoundaryAdapter());
  engine.registerAdapter('test-runner', new TestRunnerAdapter());
  engine.registerAdapter('security-scan', new SecurityScanAdapter());
  engine.registerAdapter('trivy', new GuardTrivyAdapter());
  try {
    const report = await engine.run({
      mode: 'guard',
      target: projectPath,
      ...(options ?? {}),
    } as CheckOptions);
    progress(id, 'done', t('pipeline.guard.jobDone'), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 门禁扫描异常:', message);
    send({ type: 'error', id, error: message });
  }
}

export async function runInspectJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'inspect', t('pipeline.inspect.jobScanning'), 0.1);
  const {
    InspectEngine,
    ESLintAdapter,
    GitleaksAdapter,
    DependencyCruiserAdapter,
    JscpdAdapter,
    TsPruneAdapter,
    SemgrepAdapter,
    DepcheckAdapter,
    TypeScriptAdapter,
    PrettierAdapter,
    CommitLintAdapter,
    NpmAuditAdapter,
  } = await import('@zh/inspect');
  const engine = new InspectEngine({ emit: () => undefined });
  // 注册常用适配器，与全流水线能力对齐
  engine.registerAdapter(new ESLintAdapter());
  engine.registerAdapter(new GitleaksAdapter());
  engine.registerAdapter(new DependencyCruiserAdapter());
  engine.registerAdapter(new JscpdAdapter());
  engine.registerAdapter(new TsPruneAdapter());
  engine.registerAdapter(new SemgrepAdapter());
  engine.registerAdapter(new DepcheckAdapter());
  engine.registerAdapter(new TypeScriptAdapter());
  engine.registerAdapter(new PrettierAdapter());
  engine.registerAdapter(new CommitLintAdapter());
  engine.registerAdapter(new NpmAuditAdapter());
  try {
    // R3d 执行面投影激活：直扫按画像裁剪 — 复用 getCachedProfile 同源快照；
    // 子进程内画像缓存未共享（主进程模块态）→ 通常为 undefined → 不裁剪（回归安全）。
    const report = await engine.runScan(projectPath, 'full', getCachedProfile() ?? undefined);
    progress(id, 'done', t('pipeline.inspect.jobDone'), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 巡检异常:', message);
    send({ type: 'error', id, error: message });
  }
}

export async function runSecurityJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'security', t('pipeline.security.scanning'), 0.1);
  const { SecurityEngine } = await import('@zh/security');
  const engine = new SecurityEngine({ emit: () => undefined });
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
    type GarbageInput = Parameters<typeof buildGarbageReport>[0];
    const fsItems = await detectFsGarbage(projectPath);

    let evaluations: GarbageInput['evaluations'] = [];
    let ruleChannelRan = false;
    try {
      const { PipelineRunner } = await import('@zh/pipeline');
      const runner = new PipelineRunner(projectPath);
      await runner.loadSopRules();
      progress(id, 'garbage', t('pipeline.garbage.ruleScanning'), 0.5);
      // 只评估 garbage 域：规则声明了 ts-prune / jscpd / depcheck，均由适配器真实执行
      const sopReport = await runner.runSopInspect({ domains: ['garbage'] });
      evaluations = sopReport.evaluations ?? [];
      ruleChannelRan = true;
    } catch (err) {
      console.warn(
        '[pipeline-worker] 垃圾规则通道异常，降级为仅文件系统检测:',
        err instanceof Error ? err.message : String(err),
      );
    }

    const report = buildGarbageReport({ projectPath, fsItems, evaluations, ruleChannelRan });
    progress(id, 'done', t('pipeline.garbage.scanDone', { count: report.summary.total }), 1.0);
    send({ type: 'result', id, report: serializePipelineReport(report) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[pipeline-worker] 垃圾扫描异常:', message);
    send({ type: 'error', id, error: message });
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

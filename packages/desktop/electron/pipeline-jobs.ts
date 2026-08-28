/**
 * 单引擎任务执行
 *
 * 独立的「重构 / 门禁 / 巡检 / 安全 / 性能」任务，由子进程消息路由分发，
 * 每个任务创建对应引擎并在完成后发送结果消息。
 */
import { t } from '@zh/i18n';
import { serializePipelineReport } from './pipeline-protocol';
import { progress, send } from './pipeline-ipc';
import { collectPerformanceIssues } from './pipeline-report';
import type { PerformanceReportIssue } from './pipeline-report';
import type { CheckOptions } from '@zh/guard';

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
    console.error('[pipeline-worker] 重构分析异常:', err instanceof Error ? err.stack || message : message);
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
  engine.registerAdapter('sensitive-info', new GuardSensitiveInfoAdapter(new FileSecretStateLookup()));
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
  try {
    const report = await engine.runScan(projectPath, 'full');
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

export async function runGarbageCleanJob(
  id: string,
  projectPath: string,
  items: Array<{ id: string; path: string; size: number; type: string }>,
): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.cleaning'), 0.1);
  const { cleanGarbage } = await import('@zh/security');
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

export async function runGarbageRestoreJob(id: string, projectPath: string, batchId: string): Promise<void> {
  progress(id, 'garbage', t('pipeline.garbage.restoring'), 0.1);
  const { restoreGarbage } = await import('@zh/security');
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
 * 性能优化检测 — 双通道合并：
 * 1) @zh/performance 引擎（静态优先骨架：包体积 / 构建配置 / tree-shaking / chunk 划分）；
 * 2) SOP inspect 的 performance 维度（ESLint 性能规则集 + Semgrep ReDoS，运行时反模式）。
 * 引擎异常不阻断——回退到仅 SOP 通道。
 */
export async function runPerformanceJob(id: string, projectPath: string): Promise<void> {
  progress(id, 'performance', t('pipeline.performance.loadingRules'), 0.1);
  try {
    const startedAt = Date.now();
    const engineIssues: PerformanceReportIssue[] = [];
    try {
      // 引擎通道：纯静态分析，不执行项目代码（P0-2 禁令）
      const { PerformanceEngine } = await import('@zh/performance');
      const engineReport = new PerformanceEngine().scan(projectPath);
      for (const issue of engineReport.issues) {
        engineIssues.push({
          id: issue.id,
          ruleId: issue.ruleId,
          severity: issue.severity,
          file: issue.file,
          line: issue.line,
          message: issue.message,
          suggestion: issue.suggestion,
          autoFixable: issue.autoFixable,
        });
      }
    } catch (err) {
      console.warn('[pipeline-worker] 性能引擎通道异常，降级为仅 SOP:', err instanceof Error ? err.message : String(err));
    }

    // SOP 通道：运行时反模式（可并行失败隔离）
    let sopIssues: PerformanceReportIssue[] = [];
    let sopDuration = 0;
    try {
      const { PipelineRunner } = await import('@zh/pipeline');
      const runner = new PipelineRunner(projectPath);
      await runner.loadSopRules();
      progress(id, 'performance', t('pipeline.performance.scanning'), 0.5);
      const inspectReport = await runner.runSopInspect();
      sopIssues = collectPerformanceIssues(inspectReport.evaluations ?? []);
      sopDuration = inspectReport.durationMs;
    } catch (err) {
      console.warn('[pipeline-worker] 性能 SOP 通道异常，降级为仅引擎:', err instanceof Error ? err.message : String(err));
    }

    const issues = dedupePerformanceIssues([...engineIssues, ...sopIssues]);
    const report = {
      summary: {
        total: issues.length,
        autoFixable: issues.filter((i) => i.autoFixable).length,
      },
      issues,
      metadata: {
        duration: Date.now() - startedAt + sopDuration,
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

/** 合并双通道问题并按 ruleId+file 去重（引擎通道优先保留） */
function dedupePerformanceIssues(issues: PerformanceReportIssue[]): PerformanceReportIssue[] {
  const seen = new Set<string>();
  const result: PerformanceReportIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.ruleId}:${issue.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(issue);
  }
  return result;
}

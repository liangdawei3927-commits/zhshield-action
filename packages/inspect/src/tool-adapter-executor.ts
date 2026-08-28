import type { AdapterResult } from './types';
import type { ToolAdapter, EventEmitter } from '@zh/shared';
import { DegradationManager, AuditLogger } from '@zh/shared';

export interface ToolAdapterExecutorDeps {
  degradationManager: DegradationManager;
  auditLogger: AuditLogger;
  emitter: EventEmitter;
  /** 单次适配器扫描硬上限（ms），防止异常工具无限挂起巡检任务；默认 120000 */
  hardTimeoutMs?: number;
}

/**
 * ToolAdapterExecutor — 执行已注册的 ToolAdapter 并聚合执行结果
 *
 * 职责：逐个执行适配器扫描，处理降级跳过 / 审计日志 / tool:executed
 * 事件 / 错误升级，返回统一的 AdapterResult 列表。
 */
export class ToolAdapterExecutor {
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private emitter: EventEmitter;
  private hardTimeoutMs: number;

  constructor(deps: ToolAdapterExecutorDeps) {
    this.degradationManager = deps.degradationManager;
    this.auditLogger = deps.auditLogger;
    this.emitter = deps.emitter;
    this.hardTimeoutMs = deps.hardTimeoutMs ?? 120_000;
  }

  async runAll(adapters: Map<string, ToolAdapter>, projectId: string): Promise<AdapterResult[]> {
    const adapterResults: AdapterResult[] = [];

    for (const [, adapter] of adapters) {
      const result = this.degradationManager.isToolSkipped(adapter.meta.id)
        ? this.makeSkippedResult(adapter)
        : await this.runAdapter(adapter, projectId);
      adapterResults.push(result);
    }

    return adapterResults;
  }

  private makeSkippedResult(adapter: ToolAdapter): AdapterResult {
    return {
      adapterId: adapter.meta.id,
      adapterName: adapter.meta.name,
      duration: 0,
      issueCount: 0,
      passed: true,
      degraded: false,
      issues: [],
    };
  }

  /**
   * 硬上限保护：即便某适配器未遵守 options.timeout（进程未退出），单次扫描也绝不会
   * 无限挂起整个巡检任务。超时即 reject，由 runAdapter 的 catch 降级为该适配器 error。
   */
  private static withHardTimeout<T>(promise: Promise<T>, ms: number, toolId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`[inspect] ${toolId} 扫描超过 ${ms}ms 硬上限，已跳过`)),
        ms,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async runAdapter(adapter: ToolAdapter, projectId: string): Promise<AdapterResult> {
    const toolStart = Date.now();
    try {
      const result = await ToolAdapterExecutor.withHardTimeout(
        adapter.scan({
          projectPath: process.cwd(),
          projectId,
          timeout: 60000,
        }),
        this.hardTimeoutMs,
        adapter.meta.id,
      );
      const duration = Date.now() - toolStart;

      // 副作用（审计日志 / 事件发射）失败不应污染扫描结果：
      // 单独捕获，避免被外层 catch 误判为 adapter 执行失败而重复 push error issue
      await this.runSideEffects(adapter, result, duration, projectId);

      const issues = result.issues.map((i) => ({
        id: i.id,
        ruleId: i.ruleId,
        severity: i.severity,
        category: i.category,
        message: i.message,
        file: i.file,
        line: i.line,
        column: i.column,
        suggestion: i.suggestion,
        autoFixable: i.autoFixable,
        source: i.source,
        fingerprint: i.fingerprint,
      }));

      // ADR #7 + C4 分域：skipped / unavailable / error 语义分离
      if (result.status === 'error') {
        this.degradationManager.escalate(result.error || 'Unknown error', adapter.meta.id);
        return {
          adapterId: adapter.meta.id,
          adapterName: adapter.meta.name,
          duration,
          issueCount: result.issues.length,
          passed: false,
          degraded: false,
          issues,
        };
      }

      if (result.status === 'unavailable') {
        // 覆盖率缺口而非故障：不 escalate；质量域 fail-open，安全域 fail-closed
        const failClosed = adapter.meta.category === 'security';
        return {
          adapterId: adapter.meta.id,
          adapterName: adapter.meta.name,
          duration,
          issueCount: result.issues.length,
          passed: !failClosed,
          degraded: true,
          issues,
        };
      }

      return {
        adapterId: adapter.meta.id,
        adapterName: adapter.meta.name,
        duration,
        issueCount: result.issues.length,
        passed: true,
        degraded: false,
        issues,
      };
    } catch (error: unknown) {
      this.degradationManager.escalate((error instanceof Error ? error.message : String(error)) || 'Unknown error', adapter.meta.id);
      return this.makeErrorResult(adapter, error, toolStart);
    }
  }

  private async runSideEffects(
    adapter: ToolAdapter,
    result: Awaited<ReturnType<ToolAdapter['scan']>>,
    duration: number,
    projectId: string,
  ): Promise<void> {
    try {
      await this.auditLogger.logToolExecution({
        tool: adapter.meta.id,
        duration,
        fileCount: result.metadata.fileCount,
        issueCount: result.issues.length,
        status: result.status,
        projectId,
      });

      await this.emitter.emit({
        type: 'tool:executed',
        payload: {
          tool: adapter.meta.id,
          status: result.status,
          duration,
          issueCount: result.issues.length,
          projectId,
          timestamp: new Date(),
        },
      });
    } catch {
      // 审计日志 / 事件发射失败不影响扫描结果
    }
  }

  private makeErrorResult(adapter: ToolAdapter, error: unknown, toolStart: number): AdapterResult {
    return {
      adapterId: adapter.meta.id,
      adapterName: adapter.meta.name,
      duration: Date.now() - toolStart,
      issueCount: 1,
      passed: false,
      issues: [{
        id: `error-${adapter.meta.id}`,
        ruleId: 'ADAPTER-ERROR',
        severity: 'error',
        category: 'quality',
        message: error instanceof Error ? error.message : String(error),
        file: '',
        line: 0,
        column: 0,
        suggestion: undefined,
        autoFixable: false,
        source: adapter.meta.id,
        fingerprint: `${adapter.meta.id}-error`,
      }],
    };
  }
}

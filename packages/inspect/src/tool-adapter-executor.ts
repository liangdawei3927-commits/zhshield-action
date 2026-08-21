import type { AdapterResult } from './types';
import type { ToolAdapter, EventEmitter } from '@zh/shared';
import { DegradationManager, AuditLogger } from '@zh/shared';

export interface ToolAdapterExecutorDeps {
  degradationManager: DegradationManager;
  auditLogger: AuditLogger;
  emitter: EventEmitter;
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

  constructor(deps: ToolAdapterExecutorDeps) {
    this.degradationManager = deps.degradationManager;
    this.auditLogger = deps.auditLogger;
    this.emitter = deps.emitter;
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

  private async runAdapter(adapter: ToolAdapter, projectId: string): Promise<AdapterResult> {
    const toolStart = Date.now();
    try {
      return await this.completeAdapterScan(adapter, projectId);
    } catch (error: unknown) {
      this.degradationManager.escalate((error instanceof Error ? error.message : String(error)) || 'Unknown error', adapter.meta.id);
      return this.makeErrorResult(adapter, error, toolStart);
    }
  }

  private async completeAdapterScan(adapter: ToolAdapter, projectId: string): Promise<AdapterResult> {
    const { result, duration } = await this.runToolScan(adapter, projectId);

    await this.applyScanOutcomes(adapter, result, duration, projectId);

    return this.buildAdapterResult(adapter, result, duration);
  }

  private async applyScanOutcomes(
    adapter: ToolAdapter,
    result: Awaited<ReturnType<ToolAdapter['scan']>>,
    duration: number,
    projectId: string,
  ): Promise<void> {
    // 副作用（审计日志 / 事件发射）失败不应污染扫描结果：
    // 单独捕获，避免被外层 catch 误判为 adapter 执行失败而重复 push error issue
    await this.runSideEffects(adapter, result, duration, projectId);

    // ADR #7：unavailable 是覆盖率缺口而非工具故障，不再 escalate 进降级链路；
    // 改由 buildAdapterResult 的 degraded 标记表达（C4 分域 fail 语义）
    if (result.status === 'error') {
      this.degradationManager.escalate(result.error || 'Unknown error', adapter.meta.id);
    }
  }

  private async runToolScan(
    adapter: ToolAdapter,
    projectId: string,
  ): Promise<{ result: Awaited<ReturnType<ToolAdapter['scan']>>; duration: number }> {
    const toolStart = Date.now();
    const result = await adapter.scan({
      projectPath: process.cwd(),
      projectId,
      timeout: 60000,
    });
    return { result, duration: Date.now() - toolStart };
  }

  private buildAdapterResult(
    adapter: ToolAdapter,
    result: Awaited<ReturnType<ToolAdapter['scan']>>,
    duration: number,
  ): AdapterResult {
    const status = result.status;
    // ADR #7：skipped（语言不适用/降级跳过）不计失败；
    //         unavailable（适用但工具缺失）是覆盖率缺口 → degraded 标记
    // C4 分域：安全类 fail-closed（unavailable 仍失败），其余 fail-open（通过但 degraded）
    const failClosed = adapter.meta.category === 'security';
    const passed = status === 'available'
      || status === 'skipped'
      || (status === 'unavailable' && !failClosed);

    return {
      adapterId: adapter.meta.id,
      adapterName: adapter.meta.name,
      duration,
      issueCount: result.issues.length,
      passed,
      degraded: status === 'unavailable',
      issues: result.issues.map((i) => ({
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
      })),
    };
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

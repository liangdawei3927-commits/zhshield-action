import type { ToolAdapter, Issue, EventEmitter, ToolResult } from '@zh/shared';
import { DegradationManager, AuditLogger } from '@zh/shared';
import type { SkippedTool } from './types';

interface CollectIssuesByToolParams {
  toolId: string;
  issues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
}

const TOOL_ISSUE_COLLECTORS: Record<string, (params: CollectIssuesByToolParams) => void> = {
  trivy: (params) =>
    params.trivyIssues.push(...params.issues.filter((i) => i.category === 'security')),
  grype: (params) =>
    params.grypeIssues.push(...params.issues.filter((i) => i.category === 'security')),
  depcheck: (params) => params.depcheckIssues.push(...params.issues),
  semgrep: (params) => params.semgrepIssues.push(...params.issues),
};

/** ScanOrchestrator.run() 的分流结果：全部 Issue 及按工具拆分的 trivy/grype/depcheck/semgrep 四路，
 *  供交叉验证（GrypeCrossValidator）与结果聚合（ResultAggregator）消费 */
export interface ScanOrchestratorResult {
  allIssues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
  /**
   * 范围外跳过的工具（out-of-scope）。与 degraded 严格分离：
   * 这是既定裁剪而非能力缺失，不计入降级，也不得渲染成「工具不可用」。
   */
  skippedTools: SkippedTool[];
}

/**
 * 扫描编排器 — 负责遍历已注册适配器、执行工具扫描、按工具分流 issue、
 * 记录审计/事件并驱动降级。SecurityEngine 的适配器执行职责内聚于此。
 */
export class ScanOrchestrator {
  private registeredAdapters = new Map<string, ToolAdapter>();
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private emitter: EventEmitter;

  constructor(
    degradationManager: DegradationManager,
    auditLogger: AuditLogger,
    emitter: EventEmitter,
  ) {
    this.degradationManager = degradationManager;
    this.auditLogger = auditLogger;
    this.emitter = emitter;
  }

  register(adapter: ToolAdapter): void {
    this.registeredAdapters.set(adapter.meta.id, adapter);
  }

  async run(projectId: string, projectPath: string): Promise<ScanOrchestratorResult> {
    const allIssues: Issue[] = [];
    const trivyIssues: Issue[] = [];
    const grypeIssues: Issue[] = [];
    const depcheckIssues: Issue[] = [];
    const semgrepIssues: Issue[] = [];
    const skippedTools: SkippedTool[] = [];

    for (const [, adapter] of this.registeredAdapters) {
      if (this.degradationManager.isToolSkipped(adapter.meta.id)) {
        continue;
      }
      // 工具开始事件：安全扫描串行跑多个外部工具（可达数分钟），
      // 开始即上报，UI 才能显示「当前在跑哪个工具」而不是长时间静默
      await this.emitter.emit({
        type: 'tool:scan-started',
        payload: {
          tool: adapter.meta.id,
          projectId,
          timestamp: new Date(),
        },
      });
      const toolIssues = await this.executeToolScan(adapter, projectId, projectPath);
      allIssues.push(...toolIssues.all);
      trivyIssues.push(...toolIssues.trivy);
      grypeIssues.push(...toolIssues.grype);
      depcheckIssues.push(...toolIssues.depcheck);
      semgrepIssues.push(...toolIssues.semgrep);
      if (toolIssues.skipped) skippedTools.push(toolIssues.skipped);
    }

    return { allIssues, trivyIssues, grypeIssues, depcheckIssues, semgrepIssues, skippedTools };
  }

  private async executeToolScan(
    adapter: ToolAdapter,
    projectId: string,
    projectPath: string,
  ): Promise<{
    all: Issue[];
    trivy: Issue[];
    grype: Issue[];
    depcheck: Issue[];
    semgrep: Issue[];
    skipped?: SkippedTool;
  }> {
    const result: {
      all: Issue[];
      trivy: Issue[];
      grype: Issue[];
      depcheck: Issue[];
      semgrep: Issue[];
      skipped?: SkippedTool;
    } = {
      all: [],
      trivy: [],
      grype: [],
      depcheck: [],
      semgrep: [],
    };
    const toolStart = Date.now();

    try {
      const scanResult = await adapter.scan({
        projectPath,
        projectId,
        timeout: 300000,
      });
      result.all.push(...scanResult.issues);
      this.collectIssuesByTool({
        toolId: adapter.meta.id,
        issues: scanResult.issues,
        trivyIssues: result.trivy,
        grypeIssues: result.grype,
        depcheckIssues: result.depcheck,
        semgrepIssues: result.semgrep,
      });
      await this.recordToolExecution(adapter, scanResult, projectId, toolStart);
      // 范围外跳过：工具本体可用，只是当前项目不适用 —— 属既定裁剪，
      // 不得 escalate 进 DegradationManager（否则既误报「工具不可用」，
      // 又累加 failureCount 推高降级等级，进而连累其他工具被静默跳过）。
      if (scanResult.status === 'skipped' && scanResult.skipReason === 'out-of-scope') {
        result.skipped = {
          tool: adapter.meta.id,
          reason: scanResult.error || '当前项目不满足该工具的适用前提',
        };
      }
    } catch (error) {
      this.handleScanError(adapter, error);
    }

    return result;
  }

  private async recordToolExecution(
    adapter: ToolAdapter,
    scanResult: ToolResult,
    projectId: string,
    toolStart: number,
  ): Promise<void> {
    const duration = Date.now() - toolStart;
    await this.auditLogger.logToolExecution({
      tool: adapter.meta.id,
      duration,
      fileCount: scanResult.metadata.fileCount,
      issueCount: scanResult.issues.length,
      status: scanResult.status,
      projectId,
    });
    await this.emitter.emit({
      type: 'tool:executed',
      payload: {
        tool: adapter.meta.id,
        status: scanResult.status,
        duration,
        issueCount: scanResult.issues.length,
        projectId,
        timestamp: new Date(),
      },
    });
    if (scanResult.status === 'error' || scanResult.status === 'unavailable') {
      this.degradationManager.escalate(scanResult.error || 'Unknown error', adapter.meta.id);
    }
  }

  private handleScanError(adapter: ToolAdapter, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.degradationManager.escalate(message || 'Unknown error', adapter.meta.id);
  }

  private collectIssuesByTool(params: CollectIssuesByToolParams): void {
    TOOL_ISSUE_COLLECTORS[params.toolId]?.(params);
  }
}

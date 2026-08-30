import type { ToolAdapter, Issue, EventEmitter, ToolResult } from '@zh/shared';
import { DegradationManager, AuditLogger } from '@zh/shared';

interface CollectIssuesByToolParams {
  toolId: string;
  issues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
}

const TOOL_ISSUE_COLLECTORS: Record<string, (params: CollectIssuesByToolParams) => void> = {
  trivy: (params) => params.trivyIssues.push(...params.issues.filter((i) => i.category === 'security')),
  grype: (params) => params.grypeIssues.push(...params.issues.filter((i) => i.category === 'security')),
  depcheck: (params) => params.depcheckIssues.push(...params.issues),
  semgrep: (params) => params.semgrepIssues.push(...params.issues),
};

export interface ScanOrchestratorResult {
  allIssues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
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

  constructor(degradationManager: DegradationManager, auditLogger: AuditLogger, emitter: EventEmitter) {
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

    for (const [, adapter] of this.registeredAdapters) {
      if (this.degradationManager.isToolSkipped(adapter.meta.id)) {
        continue;
      }
      const toolIssues = await this.executeToolScan(adapter, projectId, projectPath);
      allIssues.push(...toolIssues.all);
      trivyIssues.push(...toolIssues.trivy);
      grypeIssues.push(...toolIssues.grype);
      depcheckIssues.push(...toolIssues.depcheck);
      semgrepIssues.push(...toolIssues.semgrep);
    }

    return { allIssues, trivyIssues, grypeIssues, depcheckIssues, semgrepIssues };
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
  }> {
    const result = { all: [] as Issue[], trivy: [] as Issue[], grype: [] as Issue[], depcheck: [] as Issue[], semgrep: [] as Issue[] };
    const toolStart = Date.now();

    try {
      const scanResult = await adapter.scan({
        projectPath,
        projectId,
        timeout: 120000,
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

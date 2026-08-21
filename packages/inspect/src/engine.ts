import type { InspectionReport, AdapterResult, Issue, InspectAdapter } from './types';
import type { ToolAdapter, EventEmitter } from '@zh/shared';
import type { SopRuleEngine } from '@zh/kernel';
import type { ProjectProfile } from '@zh/dependency';
import { DegradationManager, AuditLogger, ToolManager, NOOP_EMITTER } from '@zh/shared';
import { AdapterRunner } from './adapter-runner';
import { ToolAdapterExecutor } from './tool-adapter-executor';
import { ScanReportBuilder } from './scan-report-builder';
import { SopReportMapper } from './sop-report-mapper';
import { AiCodeReviewImpl } from './ai-code/review';
import type { AiCodeVuln } from './ai-code/types';

/**
 * InspectEngine — 巡检引擎（门面）
 *
 * 职责：注册/管理适配器，编排巡检流程（直接执行或 SOP 驱动），
 * 聚合执行与报告构建。具体职责已拆分：
 * - ToolAdapterExecutor：适配器执行循环
 * - ScanReportBuilder：汇总/评分/建议/事件
 * - SopReportMapper：SOP 报告结构映射
 */
export class InspectEngine {
  private runner: AdapterRunner;
  private toolManager: ToolManager;
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private registeredAdapters = new Map<string, ToolAdapter>();
  private emitter: EventEmitter;
  private sopEngine?: SopRuleEngine;
  /** SOP 重入保护：防止 scanner-dispatch 规则回调 runScan → 再次 evaluateRules 造成无限递归 */
  private _sopScanning = false;
  private adapterExecutor: ToolAdapterExecutor;
  private reportBuilder: ScanReportBuilder;
  private sopMapper: SopReportMapper;
  private aiReview: AiCodeReviewImpl;

  constructor(emitter?: EventEmitter) {
    this.runner = new AdapterRunner();
    this.toolManager = new ToolManager();
    this.degradationManager = new DegradationManager();
    this.auditLogger = new AuditLogger();
    this.emitter = emitter ?? NOOP_EMITTER;
    this.adapterExecutor = new ToolAdapterExecutor({
      degradationManager: this.degradationManager,
      auditLogger: this.auditLogger,
      emitter: this.emitter,
    });
    this.reportBuilder = new ScanReportBuilder(this.emitter, this.degradationManager);
    this.sopMapper = new SopReportMapper();
    this.aiReview = new AiCodeReviewImpl();
  }

  /** 切换至 SOP 驱动模式 — 从 SopRuleEngine 获取 inspect/security 域规则并执行 */
  useSopEngine(engine: SopRuleEngine): void {
    this.sopEngine = engine;
    // 将已注册的 ToolAdapter 全部注入 SOP 引擎，供 tool-dispatch 使用
    for (const [, adapter] of this.registeredAdapters) {
      engine.registerToolAdapter(adapter.meta.id, adapter);
    }
  }

  registerAdapter(adapter: ToolAdapter | InspectAdapter): void {
    if ('meta' in adapter && 'scan' in adapter) {
      const toolAdapter = adapter as ToolAdapter;
      this.registeredAdapters.set(toolAdapter.meta.id, toolAdapter);
      this.toolManager.register(toolAdapter);
      if (this.sopEngine) {
        this.sopEngine.registerToolAdapter(toolAdapter.meta.id, toolAdapter);
      }
    } else {
      this.runner.register(adapter);
    }
  }

  getToolManager(): ToolManager {
    return this.toolManager;
  }

  getDegradationManager(): DegradationManager {
    return this.degradationManager;
  }

  async runScan(projectId: string, scanType: InspectionReport['scanType'] = 'full'): Promise<InspectionReport> {
    const start = Date.now();

    // SOP 驱动模式：通过 SopRuleEngine 评估 inspect/security 域规则
    // ⚠️ 重入保护：_sopScanning 标志防止 SOP scanner-dispatch 规则回调 runScan 导致无限递归
    // SOP → evaluateRules → scanner-dispatch → runScan → SOP → evaluateRules → ...
    if (this.sopEngine && !this._sopScanning) {
      this._sopScanning = true;
      try {
        return await this.runScanWithSop(projectId, scanType, start);
      } finally {
        this._sopScanning = false;
      }
    }

    const adapterResults: AdapterResult[] = await this.adapterExecutor.runAll(this.registeredAdapters, projectId);
    const legacyResults = await this.runner.runAll({ projectId, scanType });
    adapterResults.push(...legacyResults);

    const aiIssues = await this.runAiCodeReview(projectId);
    const allIssues: Issue[] = [...aiIssues, ...adapterResults.flatMap((r) => r.issues)];
    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - start, allIssues);

    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - start,
      issues: allIssues,
      adapterResults,
    });
  }

  /** 构建最小项目画像（AI 审查仅消费 projectPath 定位清单与源码） */
  private buildAiProfile(projectId: string): ProjectProfile {
    return { projectPath: projectId, language: 'typescript', framework: null, packageManager: 'pnpm', hasTypeScript: true };
  }

  private mapAiSeverity(severity: AiCodeVuln['severity']): Issue['severity'] {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'error';
      case 'medium':
        return 'warning';
      case 'low':
        return 'info';
    }
  }

  private aiVulnsToIssues(vulns: readonly AiCodeVuln[]): Issue[] {
    return vulns.map((v) => ({
      id: v.vulnId,
      ruleId: v.ruleId,
      severity: this.mapAiSeverity(v.severity),
      category: 'security' as const,
      message: v.description,
      file: v.file,
      line: v.line,
      suggestion: v.fix,
      autoFixable: false,
      source: 'ai-code-review' as const,
      fingerprint: `${v.ruleId}:${v.file}:${v.line}`,
    }));
  }

  /**
   * AI 代码审查（Pro 层 deepReview）：失败不阻断巡检 —— 记录警告并跳过 AI 问题
   */
  private async runAiCodeReview(projectId: string): Promise<Issue[]> {
    try {
      const vulns = await this.aiReview.deepReview(this.buildAiProfile(projectId));
      return this.aiVulnsToIssues(vulns);
    } catch {
      console.warn('[inspect] AI code review skipped — error during deepReview');
      return [];
    }
  }

  private async runScanWithSop(
    projectId: string,
    scanType: InspectionReport['scanType'],
    start: number,
  ): Promise<InspectionReport> {
    // 只评估 inspect / security 域，避免拉入 guard/evolve 等规则形成交叉重入
    const inspectReport = await this.sopEngine!.evaluateRules({
      repoRoot: projectId,
      domain: 'inspect',
    });
    const securityReport = await this.sopEngine!.evaluateRules({
      repoRoot: projectId,
      domain: 'security',
    });
    const sopReport = this.sopMapper.mergeReports(inspectReport, securityReport);

    const issues = this.sopMapper.flattenViolations(sopReport);
    const adapterResults = this.sopMapper.buildAdapterResults(sopReport);

    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - start, issues);

    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - start,
      issues,
      adapterResults,
      penalizeInfo: false,
    });
  }
}

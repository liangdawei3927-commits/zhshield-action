import type { InspectionReport, AdapterResult, Issue, InspectAdapter } from './types';
import type { ToolAdapter, EventEmitter, Baseline } from '@zh/shared';
import { filterIssuesByBaseline } from '@zh/shared';
import type { SopRuleEngine } from '@zh/kernel';
import type { ProjectProfile } from '@zh/dependency';
import {
  DegradationManager,
  AuditLogger,
  ToolManager,
  NOOP_EMITTER,
  wrapAdapter,
} from '@zh/shared';
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
      // F0-3：注册时包装 Hook 层；F5-2：越界访问经 emitter 发出 tool:scope-violation（warn-only）
      const toolAdapter = wrapAdapter(adapter as ToolAdapter, [], {
        onScopeViolation: (violation, { options }) => {
          void this.emitter.emit({
            type: 'tool:scope-violation',
            payload: {
              tool: toolAdapter.meta.id,
              projectId: options.projectId,
              file: violation.file,
              reason: violation.reason,
              timestamp: new Date(),
            },
          });
        },
      });
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

  async runScan(
    projectId: string,
    scanType: InspectionReport['scanType'] = 'full',
    projectFeature?: { framework?: string; language?: string; features?: string[] },
    baseline?: Baseline | null,
  ): Promise<InspectionReport> {
    const start = Date.now();
    if (this.sopEngine && !this._sopScanning) {
      return this.runSopGuarded(projectId, scanType, start, projectFeature, baseline);
    }
    return this.runDirectScan(projectId, scanType, start, projectFeature, baseline);
  }

  /** SOP 驱动模式：评估 inspect/security 域规则（带重入保护） */
  private async runSopGuarded(
    projectId: string,
    scanType: InspectionReport['scanType'],
    start: number,
    projectFeature?: { framework?: string; language?: string; features?: string[] },
    baseline?: Baseline | null,
  ): Promise<InspectionReport> {
    // ⚠️ 重入保护：_sopScanning 标志防止 SOP scanner-dispatch 规则回调 runScan 导致无限递归
    // SOP → evaluateRules → scanner-dispatch → runScan → SOP → evaluateRules → ...
    this._sopScanning = true;
    try {
      return await this.runScanWithSop(projectId, scanType, start, projectFeature, baseline);
    } finally {
      this._sopScanning = false;
    }
  }

  /** 直接执行模式：运行全部适配器 + AI 审查并构建报告 */
  private async runDirectScan(
    projectId: string,
    scanType: InspectionReport['scanType'],
    start: number,
    projectFeature?: { framework?: string; language?: string; features?: string[] },
    baseline?: Baseline | null,
  ): Promise<InspectionReport> {
    const adapterResults: AdapterResult[] = await this.adapterExecutor.runAll(
      this.registeredAdapters,
      projectId,
      projectFeature,
    );
    const legacyResults = await this.runner.runAll({ projectId, scanType });
    adapterResults.push(...legacyResults);

    const aiIssues = await this.runAiCodeReview(projectId);
    const allIssues: Issue[] = [...aiIssues, ...adapterResults.flatMap((r) => r.issues)];
    const { kept, suppressed } = filterIssuesByBaseline(allIssues, baseline ?? null, projectId);
    const reconciledResults = this.reconcileAdapterResults(
      adapterResults,
      baseline ?? null,
      projectId,
    );
    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - start, kept);

    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - start,
      issues: kept,
      adapterResults: reconciledResults,
      suppressedCount: suppressed,
    });
  }

  /**
   * 基线豁免后的适配器结果重算：剔除已豁免 issue，同步 issueCount/passed/status。
   * 未接入基线（null/空）时原样返回；规则所有 issue 全部豁免 → 该规则视为通过，
   * 避免报告出现"0 问题但工具 failed"的矛盾（SOP 模式的 failed 即 violations 命中态）。
   */
  private reconcileAdapterResults(
    adapterResults: AdapterResult[],
    baseline: Baseline | null,
    projectId: string,
  ): AdapterResult[] {
    if (!baseline || baseline.entries.length === 0) return adapterResults;
    return adapterResults.map((result) => {
      const { kept, suppressed } = filterIssuesByBaseline(result.issues, baseline, projectId);
      if (suppressed === 0) return result;
      const fullySuppressed = kept.length === 0 && result.issues.length > 0;
      const status =
        fullySuppressed && result.status !== 'unavailable' && result.status !== 'skipped'
          ? ('passed' as const)
          : result.status;
      return {
        ...result,
        issues: kept,
        issueCount: kept.length,
        passed: fullySuppressed ? true : result.passed,
        status,
      };
    });
  }

  /** 构建最小项目画像（AI 审查仅消费 projectPath 定位清单与源码） */
  private buildAiProfile(projectId: string): ProjectProfile {
    return {
      projectPath: projectId,
      language: 'typescript',
      framework: null,
      packageManager: 'pnpm',
      hasTypeScript: true,
    };
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
    projectFeature?: { framework?: string; language?: string; features?: string[] },
    baseline?: Baseline | null,
  ): Promise<InspectionReport> {
    // R3d 执行面投影激活：SOP 直扫分支透传画像 → evaluateRules 收到 projectFeature
    // → host.toolScope 生效 → tool-dispatch 按画像裁剪；无画像 → 不携带 → 不裁剪（回归安全）。
    // features 可选入参 → kernel ProjectFeature 必填语义：边界归一化为 []（保守：不裁剪）。
    const featureCtx = projectFeature
      ? { projectFeature: { ...projectFeature, features: projectFeature.features ?? [] } }
      : {};
    // 只评估 inspect / security 域，避免拉入 guard/evolve 等规则形成交叉重入
    const inspectReport = await this.sopEngine!.evaluateRules({
      repoRoot: projectId,
      domain: 'inspect',
      ...featureCtx,
    });
    const securityReport = await this.sopEngine!.evaluateRules({
      repoRoot: projectId,
      domain: 'security',
      ...featureCtx,
    });
    const sopReport = this.sopMapper.mergeReports(inspectReport, securityReport);

    const allIssues = this.sopMapper.flattenViolations(sopReport);
    const { kept, suppressed } = filterIssuesByBaseline(allIssues, baseline ?? null, projectId);
    const adapterResults = this.reconcileAdapterResults(
      this.sopMapper.buildAdapterResults(sopReport),
      baseline ?? null,
      projectId,
    );

    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - start, kept);

    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - start,
      issues: kept,
      adapterResults,
      penalizeInfo: false,
      suppressedCount: suppressed,
    });
  }
}

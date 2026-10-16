import type { InspectionReport, AdapterResult, Issue, InspectAdapter } from './types';
import type { ToolAdapter, EventEmitter, Baseline } from '@zh/shared';
import { filterIssuesByBaseline } from '@zh/shared';
import * as path from 'node:path';
import type { SopRuleEngine, RuleEngineReport, ProjectFeature } from '@zh/kernel';
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

/** InspectEngine.runSopGuarded 的执行参数 */
interface RunSopGuardedParams {
  projectId: string;
  scanType: InspectionReport['scanType'];
  start: number;
  projectFeature?: { framework?: string; language?: string; features?: string[] };
  baseline?: Baseline | null;
}

/** InspectEngine.runDirectScan 的执行参数 */
interface RunDirectScanParams {
  projectId: string;
  scanType: InspectionReport['scanType'];
  start: number;
  projectFeature?: { framework?: string; language?: string; features?: string[] };
  baseline?: Baseline | null;
}

/** InspectEngine.runScanWithSop 的执行参数 */
interface RunScanWithSopParams {
  projectId: string;
  scanType: InspectionReport['scanType'];
  start: number;
  projectFeature?: { framework?: string; language?: string; features?: string[] };
  baseline?: Baseline | null;
}

/** SOP 评估上下文中的项目画像（可选；缺省 → 不裁剪） */
interface SopFeatureContext {
  projectFeature?: ProjectFeature;
}

/** InspectEngine.buildSopReport 的执行参数：扫描类型、起始时间、基线与 SOP 报告 */
interface BuildSopReportParams {
  scanType: InspectionReport['scanType'];
  start: number;
  baseline: Baseline | null | undefined;
  sopReport: RuleEngineReport;
}

/** InspectEngine.finalizeScan 的执行参数（直扫 / SOP 两分支共用的报告收尾） */
interface FinalizeScanParams {
  projectId: string;
  scanType: InspectionReport['scanType'];
  start: number;
  baseline: Baseline | null | undefined;
  allIssues: Issue[];
  adapterResults: AdapterResult[];
  /** SOP 分支不惩罚 info 级问题；缺省即惩罚（直扫原行为） */
  penalizeInfo?: boolean;
}

/**
 * 构建 SOP 评估上下文中的项目画像。
 *
 * R3d 执行面投影激活：SOP 直扫分支透传画像 → evaluateRules 收到 projectFeature
 * → host.toolScope 生效 → tool-dispatch 按画像裁剪；无画像 → 不携带 → 不裁剪（回归安全）。
 * features 可选入参 → kernel ProjectFeature 必填语义：边界归一化为 []（保守：不裁剪）。
 */
function buildFeatureContext(
  projectFeature?: { framework?: string; language?: string; features?: string[] },
): SopFeatureContext {
  return projectFeature
    ? { projectFeature: { ...projectFeature, features: projectFeature.features ?? [] } }
    : {};
}

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
    // 归一化 projectId 为绝对路径：服务端 InspectService 直连引擎时可能传入相对路径，
    // 相对路径会流入 ToolScanOptions.projectPath，外部工具以自身 cwd 解析导致扫描失败。
    projectId = path.resolve(projectId);
    if (this.sopEngine && !this._sopScanning) {
      return this.runSopGuarded({ projectId, scanType, start, projectFeature, baseline });
    }
    return this.runDirectScan({ projectId, scanType, start, projectFeature, baseline });
  }

  /** SOP 驱动模式：评估 inspect/security 域规则（带重入保护） */
  private async runSopGuarded(params: RunSopGuardedParams): Promise<InspectionReport> {
    const { projectId, scanType, start, projectFeature, baseline } = params;
    // ⚠️ 重入保护：_sopScanning 标志防止 SOP scanner-dispatch 规则回调 runScan 导致无限递归
    // SOP → evaluateRules → scanner-dispatch → runScan → SOP → evaluateRules → ...
    this._sopScanning = true;
    try {
      return await this.runScanWithSop({ projectId, scanType, start, projectFeature, baseline });
    } finally {
      this._sopScanning = false;
    }
  }

  /** 直接执行模式：运行全部适配器 + AI 审查并构建报告 */
  private async runDirectScan(params: RunDirectScanParams): Promise<InspectionReport> {
    const { projectId, scanType, start, projectFeature, baseline } = params;
    const adapterResults: AdapterResult[] = await this.adapterExecutor.runAll(
      this.registeredAdapters,
      projectId,
      projectFeature,
    );
    const legacyResults = await this.runner.runAll({ projectId, scanType });
    adapterResults.push(...legacyResults);

    const aiIssues = await this.runAiCodeReview(projectId);
    const allIssues: Issue[] = [...aiIssues, ...adapterResults.flatMap((r) => r.issues)];
    return this.finalizeScan({ projectId, scanType, start, baseline, allIssues, adapterResults });
  }

  /**
   * 扫描收尾：基线过滤 → 适配器结果重算 → 发出 scan:completed 事件 → 报告构建。
   *
   * 直扫与 SOP 两分支的收尾此前逐行相同（engine.ts 内的自重复），仅 SOP 分支额外传
   * penalizeInfo=false，故收敛为唯一实现；基线豁免计数、计分与事件口径均不变。
   */
  private async finalizeScan(params: FinalizeScanParams): Promise<InspectionReport> {
    const { projectId, scanType, start, baseline, allIssues, adapterResults } = params;
    const { kept, suppressed, suppressedIssues, dormantEntries, expiredEntries } =
      filterIssuesByBaseline(allIssues, baseline ?? null, projectId);
    const reconciled = this.reconcileAdapterResults(adapterResults, baseline ?? null, projectId);
    await this.reportBuilder.emitScanCompleted(projectId, Date.now() - start, kept);
    return this.reportBuilder.buildReport({
      projectId,
      scanType,
      duration: Date.now() - start,
      issues: kept,
      adapterResults: reconciled,
      penalizeInfo: params.penalizeInfo,
      suppressedCount: suppressed,
      suppressedIssues,
      dormantEntries,
      expiredEntries,
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

  private async runScanWithSop(params: RunScanWithSopParams): Promise<InspectionReport> {
    const { projectId, scanType, start, projectFeature, baseline } = params;
    const featureCtx = buildFeatureContext(projectFeature);
    const sopEngine = this.sopEngine;
    if (!sopEngine) {
      throw new Error('SOP engine not registered');
    }
    const sopReport = await this.evaluateSopReports(sopEngine, projectId, featureCtx);
    return this.buildSopReport(projectId, { scanType, start, baseline, sopReport });
  }

  /** 评估 inspect / security 两个域的规则并合并报告（避免拉入 guard/evolve 等规则形成交叉重入） */
  private async evaluateSopReports(
    sopEngine: SopRuleEngine,
    projectId: string,
    featureCtx: SopFeatureContext,
  ): Promise<RuleEngineReport> {
    const inspectReport = await sopEngine.evaluateRules({
      repoRoot: projectId,
      domain: 'inspect',
      ...featureCtx,
    });
    const securityReport = await sopEngine.evaluateRules({
      repoRoot: projectId,
      domain: 'security',
      ...featureCtx,
    });
    return this.sopMapper.mergeReports(inspectReport, securityReport);
  }

  /** 汇总 SOP 报告：扁平化违规 → 基线过滤 → 适配器结果重算 → 事件与报告构建 */
  private async buildSopReport(
    projectId: string,
    params: BuildSopReportParams,
  ): Promise<InspectionReport> {
    const { scanType, start, baseline, sopReport } = params;
    return this.finalizeScan({
      projectId,
      scanType,
      start,
      baseline,
      allIssues: this.sopMapper.flattenViolations(sopReport),
      adapterResults: this.sopMapper.buildAdapterResults(sopReport),
      penalizeInfo: false,
    });
  }
}

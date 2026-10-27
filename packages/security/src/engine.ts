import type { ToolAdapter, EventEmitter, Issue } from '@zh/shared';
import {
  DegradationManager,
  AuditLogger,
  ToolManager,
  NOOP_EMITTER,
  wrapAdapter,
} from '@zh/shared';
import * as path from 'node:path';
import type { Vulnerability, SecurityScanReport, GarbageItem, MalwareItem } from './types';
import { calculateSecurityScore } from './types';
import { VulnerabilityScanner } from './vulnerability-scanner';
import { scanGarbage } from './garbage-scanner';
import { MalwareScanner } from './malware-scanner';
import { GrypeCrossValidator } from './cross-validator';
import { RuleConflictResolver } from './rule-conflict-resolver';
import type { RuleConflictReport } from './rule-conflict-resolver';
import {
  TrivyAdapter,
  GrypeAdapter,
  DepcheckAdapter,
  SemgrepAdapter,
} from './adapters';
import { ScanOrchestrator } from './engine-scan-orchestrator';
import { ResultAggregator } from './engine-result-aggregator';

interface SecurityBuildReportParams {
  projectId: string;
  vulnerabilities: Vulnerability[];
  garbage: GarbageItem[];
  malware: MalwareItem[];
  conflictReport: RuleConflictReport;
  /** 依赖审计失败原因（VulnerabilityScanner.lastError；成功为空） */
  auditError?: string;
}

export class SecurityEngine {
  private toolManager: ToolManager;
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private emitter: EventEmitter;
  private scanOrchestrator: ScanOrchestrator;
  private resultAggregator: ResultAggregator;
  /** 持有引用以便扫描后读取 lastError（P1-4：审计失败必须显形，不许静默 0） */
  private readonly vulnerabilityScanner = new VulnerabilityScanner();

  constructor(emitter?: EventEmitter) {
    this.toolManager = new ToolManager();
    this.degradationManager = new DegradationManager();
    this.auditLogger = new AuditLogger();
    this.emitter = emitter ?? NOOP_EMITTER;
    this.scanOrchestrator = new ScanOrchestrator(
      this.degradationManager,
      this.auditLogger,
      this.emitter,
    );
    this.resultAggregator = new ResultAggregator(
      this.vulnerabilityScanner,
      scanGarbage,
      new MalwareScanner(),
      new GrypeCrossValidator(),
      new RuleConflictResolver(),
    );
  }

  registerAdapter(adapter: ToolAdapter): void {
    // F0-3：注册时包装 Hook 层；F5-2：越界访问经 emitter 发出 tool:scope-violation（warn-only）
    const wrapped = wrapAdapter(adapter, [], {
      onScopeViolation: (violation, { options }) => {
        void this.emitter.emit({
          type: 'tool:scope-violation',
          payload: {
            tool: adapter.meta.id,
            projectId: options.projectId,
            file: violation.file,
            reason: violation.reason,
            timestamp: new Date(),
          },
        });
      },
    });
    this.scanOrchestrator.register(wrapped);
    this.toolManager.register(wrapped);
  }

  /**
   * 注册生产路径默认安全适配器（Trivy/Grype/Depcheck/Semgrep）。
   * 不放构造函数，以保留「无适配器」测试构造路径（security-engine.test 断言）。
   * 消除 guard 侧用 GuardTrivyAdapter 而 security 侧 TrivyAdapter 闲置的分裂。
   *
   * ORT 不在此列（2026-10-28 决策）：它是「半接线」适配器，净收益为负——
   * ① 结果不落地：engine-scan-orchestrator 的 TOOL_ISSUE_COLLECTORS 无 ort 分流器，
   *    ORT 产出的许可证 issue 只进 allIssues，而 ResultAggregator 只消费
   *    trivy/grype/depcheck/semgrep 四路，故不落到报告任何字段（能力实际未生效）；
   * ② 却只增成本：ORT 不可用时 recordToolExecution 仍 escalate 进
   *    degraded.unavailableTools，令整份报告显示「结果可能不完整」；
   * ③ 装不上：ORT 是 JVM 分发包，install-tools 的 binary 模式无法纳管。
   * 许可证合规改由 trivy 承接（已实装 0.74.0，实机验证支持 --scanners license），
   * 待报告模型新增 license 维度后再评估是否重新启用 ORT。
   */
  registerDefaultAdapters(): void {
    this.registerAdapter(new TrivyAdapter());
    this.registerAdapter(new GrypeAdapter());
    this.registerAdapter(new DepcheckAdapter());
    this.registerAdapter(new SemgrepAdapter());
  }

  getToolManager(): ToolManager {
    return this.toolManager;
  }

  getDegradationManager(): DegradationManager {
    return this.degradationManager;
  }

  async runSecurityScan(projectId: string, projectPath: string): Promise<SecurityScanReport> {
    const start = Date.now();
    // 归一化 projectPath 为绝对路径：服务端/桌面端直连引擎时可能传入相对路径，
    // 相对路径会流入 ToolScanOptions.projectPath，外部工具以自身 cwd 解析导致扫描失败。
    projectPath = path.resolve(projectPath);
    const { allIssues, trivyIssues, grypeIssues, depcheckIssues, semgrepIssues } =
      await this.scanOrchestrator.run(projectId, projectPath);
    const { garbage, malware, vulnerabilities, conflictReport } =
      await this.resultAggregator.collect({
        projectPath,
        depcheckIssues,
        semgrepIssues,
        trivyIssues,
        grypeIssues,
      });
    await this.emitScanCompleted(projectId, start, allIssues, vulnerabilities);
    return this.buildReport({
      projectId,
      vulnerabilities,
      garbage,
      malware,
      conflictReport,
      auditError: this.vulnerabilityScanner.lastError || undefined,
    });
  }

  private buildReport(params: SecurityBuildReportParams): SecurityScanReport {
    const { projectId, vulnerabilities, garbage, malware, conflictReport, auditError } = params;
    const summary = summarizeFindings(vulnerabilities, garbage, malware);
    const securityScore = calculateSecurityScore(vulnerabilities);
    // P1-4：工具不可用 / 审计失败 → 随报告带 degraded。0 检出的语义由调用方解读：
    // 带 degraded 的 0 是「没检测成」，不带 degraded 的 0 才是「查过且干净」。
    const unavailableTools = [...this.degradationManager.getToolErrors().keys()];
    const degraded =
      unavailableTools.length > 0 || auditError
        ? {
            unavailableTools,
            ...(auditError ? { auditError } : {}),
          }
        : undefined;
    return {
      projectId,
      timestamp: new Date(),
      vulnerabilities,
      garbage,
      malware,
      securityScore,
      summary,
      conflictReport,
      ...(degraded ? { degraded } : {}),
    };
  }

  private async emitScanCompleted(
    projectId: string,
    start: number,
    allIssues: Issue[],
    vulnerabilities: Vulnerability[],
  ): Promise<void> {
    await this.emitter.emit({
      type: 'scan:completed',
      payload: {
        module: 'security',
        projectId,
        duration: Date.now() - start,
        totalIssues: allIssues.length,
        issueCategories: {
          security: vulnerabilities.length,
          dependency: allIssues.filter((i) => i.category === 'dependency').length,
        },
        timestamp: new Date(),
      },
    });
  }
}

function summarizeFindings(
  vulnerabilities: Vulnerability[],
  garbage: GarbageItem[],
  malware: MalwareItem[],
): SecurityScanReport['summary'] {
  return {
    vulnTotal: vulnerabilities.length,
    vulnCritical: vulnerabilities.filter((v) => v.severity === 'critical').length,
    vulnHigh: vulnerabilities.filter((v) => v.severity === 'high').length,
    vulnMedium: vulnerabilities.filter((v) => v.severity === 'medium').length,
    vulnLow: vulnerabilities.filter((v) => v.severity === 'low').length,
    garbageTotal: garbage.length,
    malwareTotal: malware.length,
  };
}

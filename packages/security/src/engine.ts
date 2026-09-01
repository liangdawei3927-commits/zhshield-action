import type { ToolAdapter, EventEmitter, Issue } from '@zh/shared';
import {
  DegradationManager,
  AuditLogger,
  ToolManager,
  NOOP_EMITTER,
  wrapAdapter,
} from '@zh/shared';
import type { Vulnerability, SecurityScanReport, GarbageItem, MalwareItem } from './types';
import { calculateSecurityScore } from './types';
import { VulnerabilityScanner } from './vulnerability-scanner';
import { GarbageScanner } from './garbage-scanner';
import { MalwareScanner } from './malware-scanner';
import { GrypeCrossValidator } from './cross-validator';
import { RuleConflictResolver } from './rule-conflict-resolver';
import type { RuleConflictReport } from './rule-conflict-resolver';
import {
  TrivyAdapter,
  GrypeAdapter,
  DepcheckAdapter,
  SemgrepAdapter,
  ORTAdapter,
} from './adapters';
import { ScanOrchestrator } from './engine-scan-orchestrator';
import { ResultAggregator } from './engine-result-aggregator';

export class SecurityEngine {
  private toolManager: ToolManager;
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private emitter: EventEmitter;
  private scanOrchestrator: ScanOrchestrator;
  private resultAggregator: ResultAggregator;

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
      new VulnerabilityScanner(),
      new GarbageScanner(),
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
   * 注册生产路径默认安全适配器（Trivy/Grype/Depcheck/Semgrep/ORT）。
   * 不放构造函数，以保留「无适配器」测试构造路径（security-engine.test 断言）。
   * 消除 guard 侧用 GuardTrivyAdapter 而 security 侧 TrivyAdapter 闲置的分裂。
   */
  registerDefaultAdapters(): void {
    this.registerAdapter(new TrivyAdapter());
    this.registerAdapter(new GrypeAdapter());
    this.registerAdapter(new DepcheckAdapter());
    this.registerAdapter(new SemgrepAdapter());
    this.registerAdapter(new ORTAdapter());
  }

  getToolManager(): ToolManager {
    return this.toolManager;
  }

  getDegradationManager(): DegradationManager {
    return this.degradationManager;
  }

  async runSecurityScan(projectId: string, projectPath: string): Promise<SecurityScanReport> {
    const start = Date.now();
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
    return this.buildReport(projectId, vulnerabilities, garbage, malware, conflictReport);
  }

  private buildReport(
    projectId: string,
    vulnerabilities: Vulnerability[],
    garbage: GarbageItem[],
    malware: MalwareItem[],
    conflictReport: RuleConflictReport,
  ): SecurityScanReport {
    const summary = summarizeFindings(vulnerabilities, garbage, malware);
    const securityScore = calculateSecurityScore(vulnerabilities);
    return {
      projectId,
      timestamp: new Date(),
      vulnerabilities,
      garbage,
      malware,
      securityScore,
      summary,
      conflictReport,
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

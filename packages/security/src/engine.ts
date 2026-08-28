import { randomUUID } from 'node:crypto';
// allow: SIZE_OK — 编排器角色（适配器执行/审计/事件/多路扫描汇聚），拆分需与 F2 并行工作协调，遗留为后续重构项
import type { ToolAdapter, Issue, EventEmitter } from '@zh/shared';
import { DegradationManager, AuditLogger, ToolManager, NOOP_EMITTER, wrapAdapter } from '@zh/shared';
import type { Vulnerability, SecurityScanReport } from './types';
import { calculateSecurityScore } from './types';
import type { GarbageItem, MalwareItem } from './types';
import { VulnerabilityScanner } from './vulnerability-scanner';
import { GarbageScanner, mapDepcheckIssuesToGarbage } from './garbage-scanner';
import { MalwareScanner, mapSemgrepIssuesToMalware } from './malware-scanner';
import { GrypeCrossValidator } from './cross-validator';
import type { CrossValidationReport } from './cross-validator';
import { InjectionGuard } from './injection-guard';
import { TrivyAdapter, GrypeAdapter, DepcheckAdapter, SemgrepAdapter, ORTAdapter } from './adapters';
import { RuleConflictResolver } from './rule-conflict-resolver';
import type { RuleConflictReport, RuleFinding } from './rule-conflict-resolver';

interface CollectIssuesByToolParams {
  toolId: string;
  issues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
}

interface CollectScannerFindingsParams {
  projectPath: string;
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
}

const TOOL_ISSUE_COLLECTORS: Record<string, (params: CollectIssuesByToolParams) => void> = {
  trivy: (params) => params.trivyIssues.push(...params.issues.filter((i) => i.category === 'security')),
  grype: (params) => params.grypeIssues.push(...params.issues.filter((i) => i.category === 'security')),
  depcheck: (params) => params.depcheckIssues.push(...params.issues),
  semgrep: (params) => params.semgrepIssues.push(...params.issues),
};

/** MalwareItem 的位置归一键 — 跨生产者（启发式/semgrep/injection-guard）对齐同一处发现 */
function malwareFingerprint(item: MalwareItem): string {
  return `${item.file}:${item.line}:${item.pattern}`;
}

function toConflictFinding(source: string, verdict: string, item: MalwareItem): RuleFinding {
  return RuleConflictResolver.finding(source, verdict, {
    id: item.id,
    ruleId: item.pattern,
    severity: item.severity === 'critical' || item.severity === 'high' ? 'error'
      : item.severity === 'medium' ? 'warning' : 'info',
    category: 'security',
    message: item.title,
    file: item.file,
    line: item.line,
    source: 'security',
    autoFixable: false,
    fingerprint: malwareFingerprint(item),
  });
}

export class SecurityEngine {
  private toolManager: ToolManager;
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private vulnerabilityScanner: VulnerabilityScanner;
  private garbageScanner: GarbageScanner;
  private malwareScanner: MalwareScanner;
  private registeredAdapters = new Map<string, ToolAdapter>();
  private emitter: EventEmitter;
  private crossValidator: GrypeCrossValidator;
  private ruleConflictResolver: RuleConflictResolver;

  constructor(emitter?: EventEmitter) {
    this.toolManager = new ToolManager();
    this.degradationManager = new DegradationManager();
    this.auditLogger = new AuditLogger();
    this.vulnerabilityScanner = new VulnerabilityScanner();
    this.garbageScanner = new GarbageScanner();
    this.malwareScanner = new MalwareScanner();
    this.emitter = emitter ?? NOOP_EMITTER;
    this.crossValidator = new GrypeCrossValidator();
    this.ruleConflictResolver = new RuleConflictResolver();
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
    this.registeredAdapters.set(wrapped.meta.id, wrapped);
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
      await this.runRegisteredAdapters(projectId, projectPath);

    const { garbage, malware, vulnerabilities, conflictReport } = await this.collectScannerFindings({
      projectPath,
      depcheckIssues,
      semgrepIssues,
      trivyIssues,
      grypeIssues,
    });

    await this.emitScanCompleted(projectId, start, allIssues, vulnerabilities);

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

  private async runRegisteredAdapters(
    projectId: string,
    projectPath: string,
  ): Promise<{
    allIssues: Issue[];
    trivyIssues: Issue[];
    grypeIssues: Issue[];
    depcheckIssues: Issue[];
    semgrepIssues: Issue[];
  }> {
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
      const duration = Date.now() - toolStart;

      result.all.push(...scanResult.issues);
      this.collectIssuesByTool({
        toolId: adapter.meta.id,
        issues: scanResult.issues,
        trivyIssues: result.trivy,
        grypeIssues: result.grype,
        depcheckIssues: result.depcheck,
        semgrepIssues: result.semgrep,
      });

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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.degradationManager.escalate(message || 'Unknown error', adapter.meta.id);
    }

    return result;
  }

  private collectIssuesByTool(params: CollectIssuesByToolParams): void {
    TOOL_ISSUE_COLLECTORS[params.toolId]?.(params);
  }

  /** F2：注入检测管线步骤 — 失败隔离，注入扫描异常不影响既有扫描结果 */
  private async runInjectionGuard(projectPath: string): Promise<MalwareItem[]> {
    try {
      return await new InjectionGuard().scan(projectPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[SecurityEngine] injection-guard scan failed: ${message || 'Unknown error'}`);
      return [];
    }
  }

  private async collectScannerFindings({
    projectPath,
    depcheckIssues,
    semgrepIssues,
    trivyIssues,
    grypeIssues,
  }: CollectScannerFindingsParams): Promise<{
    garbage: GarbageItem[];
    malware: MalwareItem[];
    vulnerabilities: Vulnerability[];
    conflictReport: RuleConflictReport;
  }> {
    const crossReport = this.crossValidator.validate(trivyIssues, grypeIssues);

    const legacyVulns = await this.vulnerabilityScanner.scan(projectPath);
    const legacyGarbage = await this.garbageScanner.scan(projectPath);
    const legacyMalware = await this.malwareScanner.scan(projectPath);
    const injectionMalware = await this.runInjectionGuard(projectPath);

    const depcheckGarbage = mapDepcheckIssuesToGarbage(depcheckIssues);
    const semgrepMalware = mapSemgrepIssuesToMalware(semgrepIssues);

    const garbage = [...legacyGarbage, ...depcheckGarbage];

    const malwareLanes: Array<{ source: string; verdict: string; items: MalwareItem[] }> = [
      { source: 'malware-heuristic', verdict: 'malware', items: legacyMalware },
      { source: 'semgrep', verdict: 'malware', items: semgrepMalware },
      { source: 'injection-guard', verdict: 'injection', items: injectionMalware },
    ];
    const conflictReport = this.ruleConflictResolver.resolve(
      malwareLanes.flatMap((lane) => lane.items.map((item) => toConflictFinding(lane.source, lane.verdict, item))),
    );
    const excludedFingerprints = new Set([
      ...conflictReport.falsePositives.map((entry) => entry.fingerprint),
      ...conflictReport.conflicts.map((entry) => entry.fingerprint),
    ]);
    const seenFingerprints = new Set<string>();
    const malware = malwareLanes.flatMap((lane) => lane.items).filter((item) => {
      const fingerprint = malwareFingerprint(item);
      if (excludedFingerprints.has(fingerprint) || seenFingerprints.has(fingerprint)) return false;
      seenFingerprints.add(fingerprint);
      return true;
    });

    const vulnerabilities: Vulnerability[] = [
      ...legacyVulns,
      ...mapCrossEntries(crossReport),
    ];

    return { garbage, malware, vulnerabilities, conflictReport };
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

/** 将交叉验证结果映射为 Vulnerability 列表 */
function mapCrossEntries(report: CrossValidationReport): Vulnerability[] {
  const result: Vulnerability[] = [];
  const all = [
    ...report.highConfidence,
    ...report.trivyOnly,
    ...report.grypeOnly,
  ];

  for (const entry of all) {
    const first = entry.issues[0];
    if (!first) continue;

    result.push({
      id: randomUUID(),
      cveId: entry.cveId || undefined,
      severity: entry.suggestedSeverity === 'error' ? 'high'
        : entry.suggestedSeverity === 'warning' ? 'medium' : 'low',
      title: first.message,
      description: first.message,
      package: first.file || entry.packageKey,
      currentVersion: '',
      vulnerableRange: '',
      fixedVersion: first.suggestion?.replace('升级到 ', ''),
      dependencyPath: [],
      isDirectDependency: true,
      cvssScore: undefined,
      recommendation: first.suggestion || '请尽快修复',
      autoFixable: first.autoFixable,
      confidence: entry.confidence,
      sourceTools: entry.sources,
    });
  }

  return result;
}

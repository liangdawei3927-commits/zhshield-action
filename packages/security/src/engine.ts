import { randomUUID } from 'node:crypto';
import type { ToolAdapter, ToolResult, Issue, EventEmitter } from '@zh/shared';
import { DegradationManager, AuditLogger, ToolManager, NOOP_EMITTER } from '@zh/shared';
import type { Vulnerability, SecurityScanReport } from './types';
import { calculateSecurityScore } from './types';
import type { GarbageItem, MalwareItem } from './types';
import { VulnerabilityScanner } from './vulnerability-scanner';
import { scanGarbage, mapDepcheckIssuesToGarbage } from './garbage-scanner';
import { MalwareScanner, mapSemgrepIssuesToMalware } from './malware-scanner';
import { scanNpmThreats } from './npm-threat-scanner';
import { scanPypiThreats } from './pypi-threat-scanner';
import { GrypeCrossValidator } from './cross-validator';
import type { CrossValidationReport } from './cross-validator';

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

interface ToolIssueBuckets {
  all: Issue[];
  trivy: Issue[];
  grype: Issue[];
  depcheck: Issue[];
  semgrep: Issue[];
}

interface RunToolScanParams {
  adapter: ToolAdapter;
  projectId: string;
  projectPath: string;
  result: ToolIssueBuckets;
  toolStart: number;
}

interface HandleToolResultParams {
  adapter: ToolAdapter;
  projectId: string;
  scanResult: ToolResult;
  result: ToolIssueBuckets;
  toolStart: number;
}

interface BuildFindingsParams {
  crossReport: CrossValidationReport;
  legacyVulns: Vulnerability[];
  legacyGarbage: GarbageItem[];
  legacyMalware: MalwareItem[];
  npmThreats: MalwareItem[];
  pypiThreats: MalwareItem[];
  depcheckGarbage: GarbageItem[];
  semgrepMalware: MalwareItem[];
}

export class SecurityEngine {
  private toolManager: ToolManager;
  private degradationManager: DegradationManager;
  private auditLogger: AuditLogger;
  private vulnerabilityScanner: VulnerabilityScanner;
  private malwareScanner: MalwareScanner;
  private registeredAdapters = new Map<string, ToolAdapter>();
  private emitter: EventEmitter;
  private crossValidator: GrypeCrossValidator;

  constructor(emitter?: EventEmitter) {
    this.toolManager = new ToolManager();
    this.degradationManager = new DegradationManager();
    this.auditLogger = new AuditLogger();
    this.vulnerabilityScanner = new VulnerabilityScanner();
    this.malwareScanner = new MalwareScanner();
    this.emitter = emitter ?? NOOP_EMITTER;
    this.crossValidator = new GrypeCrossValidator();
  }

  registerAdapter(adapter: ToolAdapter): void {
    this.registeredAdapters.set(adapter.meta.id, adapter);
    this.toolManager.register(adapter);
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
    const { garbage, malware, vulnerabilities } = await this.collectScannerFindings({
      projectPath,
      depcheckIssues,
      semgrepIssues,
      trivyIssues,
      grypeIssues,
    });

    await this.emitScanCompleted(projectId, start, allIssues, vulnerabilities);

    return this.buildReport(projectId, vulnerabilities, garbage, malware);
  }

  private buildReport(
    projectId: string,
    vulnerabilities: Vulnerability[],
    garbage: GarbageItem[],
    malware: MalwareItem[],
  ): SecurityScanReport {
    return {
      projectId,
      timestamp: new Date(),
      vulnerabilities,
      garbage,
      malware,
      securityScore: calculateSecurityScore(vulnerabilities, malware),
      summary: this.summarizeFindings(vulnerabilities, garbage, malware),
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
  ): Promise<ToolIssueBuckets> {
    const result: ToolIssueBuckets = { all: [], trivy: [], grype: [], depcheck: [], semgrep: [] };
    const toolStart = Date.now();

    await this.runToolScan({ adapter, projectId, projectPath, result, toolStart });

    return result;
  }

  private async runToolScan(params: RunToolScanParams): Promise<void> {
    const { adapter, projectId, projectPath, result, toolStart } = params;
    try {
      const scanResult = await adapter.scan({
        projectPath,
        projectId,
        timeout: 120000,
      });
      await this.handleToolResult({ adapter, projectId, scanResult, result, toolStart });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.degradationManager.escalate(message || 'Unknown error', adapter.meta.id);
    }
  }

  private async handleToolResult(params: HandleToolResultParams): Promise<void> {
    const { adapter, projectId, scanResult, result, toolStart } = params;
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

    await this.logAndEmitToolExecution(adapter, projectId, scanResult, duration);

    if (scanResult.status === 'error' || scanResult.status === 'unavailable') {
      this.degradationManager.escalate(scanResult.error || 'Unknown error', adapter.meta.id);
    }
  }

  private async logAndEmitToolExecution(
    adapter: ToolAdapter,
    projectId: string,
    scanResult: ToolResult,
    duration: number,
  ): Promise<void> {
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
  }

  private collectIssuesByTool(params: CollectIssuesByToolParams): void {
    TOOL_ISSUE_COLLECTORS[params.toolId]?.(params);
  }

  private async collectScannerFindings({
    projectPath,
    depcheckIssues,
    semgrepIssues,
    trivyIssues,
    grypeIssues,
  }: CollectScannerFindingsParams): Promise<{ garbage: GarbageItem[]; malware: MalwareItem[]; vulnerabilities: Vulnerability[] }> {
    const crossReport = this.crossValidator.validate(trivyIssues, grypeIssues);

    const [legacyVulns, legacyGarbage, legacyMalware, npmThreats, pypiThreats] = await this.runLegacyScanners(projectPath);
    const depcheckGarbage = mapDepcheckIssuesToGarbage(depcheckIssues);
    const semgrepMalware = mapSemgrepIssuesToMalware(semgrepIssues);

    return this.buildFindings({ crossReport, legacyVulns, legacyGarbage, legacyMalware, npmThreats, pypiThreats, depcheckGarbage, semgrepMalware });
  }

  private async runLegacyScanners(projectPath: string): Promise<[Vulnerability[], GarbageItem[], MalwareItem[], MalwareItem[], MalwareItem[]]> {
    return Promise.all([
      this.vulnerabilityScanner.scan(projectPath),
      scanGarbage(projectPath),
      this.malwareScanner.scan(projectPath),
      scanNpmThreats(projectPath),
      scanPypiThreats(projectPath),
    ]);
  }

  private buildFindings(params: BuildFindingsParams): { garbage: GarbageItem[]; malware: MalwareItem[]; vulnerabilities: Vulnerability[] } {
    const { crossReport, legacyVulns, legacyGarbage, legacyMalware, npmThreats, pypiThreats, depcheckGarbage, semgrepMalware } = params;
    return {
      garbage: [...legacyGarbage, ...depcheckGarbage],
      malware: [...legacyMalware, ...semgrepMalware, ...npmThreats, ...pypiThreats],
      vulnerabilities: [...legacyVulns, ...this.mapCrossEntries(crossReport)],
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

  private summarizeFindings(
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
  private mapCrossEntries(report: CrossValidationReport): Vulnerability[] {
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
}

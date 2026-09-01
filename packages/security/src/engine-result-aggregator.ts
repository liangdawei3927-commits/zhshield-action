import { randomUUID } from 'node:crypto';
import type { Issue } from '@zh/shared';
import type { Vulnerability, GarbageItem, MalwareItem } from './types';
import { VulnerabilityScanner } from './vulnerability-scanner';
import { GarbageScanner, mapDepcheckIssuesToGarbage } from './garbage-scanner';
import { MalwareScanner, mapSemgrepIssuesToMalware } from './malware-scanner';
import type { CrossValidationReport } from './cross-validator';
import { InjectionGuard } from './injection-guard';
import { RuleConflictResolver } from './rule-conflict-resolver';
import type { RuleConflictReport, RuleFinding } from './rule-conflict-resolver';

interface CollectScannerFindingsParams {
  projectPath: string;
  depcheckIssues: Issue[];
  semgrepIssues: Issue[];
  trivyIssues: Issue[];
  grypeIssues: Issue[];
}

/** MalwareItem 的位置归一键 — 跨生产者（启发式/semgrep/injection-guard）对齐同一处发现 */
function malwareFingerprint(item: MalwareItem): string {
  return `${item.file}:${item.line}:${item.pattern}`;
}

function toConflictFinding(source: string, verdict: string, item: MalwareItem): RuleFinding {
  return RuleConflictResolver.finding(source, verdict, {
    id: item.id,
    ruleId: item.pattern,
    severity:
      item.severity === 'critical' || item.severity === 'high'
        ? 'error'
        : item.severity === 'medium'
          ? 'warning'
          : 'info',
    category: 'security',
    message: item.title,
    file: item.file,
    line: item.line,
    source: 'security',
    autoFixable: false,
    fingerprint: malwareFingerprint(item),
  });
}

/** 将交叉验证结果映射为 Vulnerability 列表 */
function mapCrossEntries(report: CrossValidationReport): Vulnerability[] {
  const result: Vulnerability[] = [];
  const all = [...report.highConfidence, ...report.trivyOnly, ...report.grypeOnly];

  for (const entry of all) {
    const first = entry.issues[0];
    if (!first) continue;

    result.push({
      id: randomUUID(),
      cveId: entry.cveId || undefined,
      severity:
        entry.suggestedSeverity === 'error'
          ? 'high'
          : entry.suggestedSeverity === 'warning'
            ? 'medium'
            : 'low',
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

export interface ResultAggregatorResult {
  garbage: GarbageItem[];
  malware: MalwareItem[];
  vulnerabilities: Vulnerability[];
  conflictReport: RuleConflictReport;
}

/**
 * 结果聚合器 — 负责汇聚各扫描器（漏洞/垃圾/恶意/注入）与交叉验证结果，
 * 解析 malware 多生产者冲突并构建最终 Vulnerability 列表。SecurityEngine
 * 的扫描结果汇聚职责内聚于此。
 */
export class ResultAggregator {
  private vulnerabilityScanner: VulnerabilityScanner;
  private garbageScanner: GarbageScanner;
  private malwareScanner: MalwareScanner;
  private crossValidator: { validate(trivy: Issue[], grype: Issue[]): CrossValidationReport };
  private ruleConflictResolver: RuleConflictResolver;

  constructor(
    vulnerabilityScanner: VulnerabilityScanner,
    garbageScanner: GarbageScanner,
    malwareScanner: MalwareScanner,
    crossValidator: { validate(trivy: Issue[], grype: Issue[]): CrossValidationReport },
    ruleConflictResolver: RuleConflictResolver,
  ) {
    this.vulnerabilityScanner = vulnerabilityScanner;
    this.garbageScanner = garbageScanner;
    this.malwareScanner = malwareScanner;
    this.crossValidator = crossValidator;
    this.ruleConflictResolver = ruleConflictResolver;
  }

  async collect({
    projectPath,
    depcheckIssues,
    semgrepIssues,
    trivyIssues,
    grypeIssues,
  }: CollectScannerFindingsParams): Promise<ResultAggregatorResult> {
    const crossReport = this.crossValidator.validate(trivyIssues, grypeIssues);
    const { legacyVulns, legacyGarbage, legacyMalware, injectionMalware } =
      await this.collectLegacyFindings(projectPath);
    const depcheckGarbage = mapDepcheckIssuesToGarbage(depcheckIssues);
    const semgrepMalware = mapSemgrepIssuesToMalware(semgrepIssues);
    const garbage = [...legacyGarbage, ...depcheckGarbage];
    const malwareLanes: Array<{ source: string; verdict: string; items: MalwareItem[] }> = [
      { source: 'malware-heuristic', verdict: 'malware', items: legacyMalware },
      { source: 'semgrep', verdict: 'malware', items: semgrepMalware },
      { source: 'injection-guard', verdict: 'injection', items: injectionMalware },
    ];
    const { conflictReport, malware } = this.resolveMalwareConflict(malwareLanes);
    const vulnerabilities = this.buildVulnerabilities(legacyVulns, crossReport);

    return { garbage, malware, vulnerabilities, conflictReport };
  }

  private async collectLegacyFindings(projectPath: string): Promise<{
    legacyVulns: Vulnerability[];
    legacyGarbage: GarbageItem[];
    legacyMalware: MalwareItem[];
    injectionMalware: MalwareItem[];
  }> {
    const legacyVulns = await this.vulnerabilityScanner.scan(projectPath);
    const legacyGarbage = await this.garbageScanner.scan(projectPath);
    const legacyMalware = await this.malwareScanner.scan(projectPath);
    const injectionMalware = await this.runInjectionGuard(projectPath);
    return { legacyVulns, legacyGarbage, legacyMalware, injectionMalware };
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

  private resolveMalwareConflict(
    malwareLanes: Array<{ source: string; verdict: string; items: MalwareItem[] }>,
  ): { conflictReport: RuleConflictReport; malware: MalwareItem[] } {
    const conflictReport = this.ruleConflictResolver.resolve(
      malwareLanes.flatMap((lane) =>
        lane.items.map((item) => toConflictFinding(lane.source, lane.verdict, item)),
      ),
    );
    const excludedFingerprints = new Set([
      ...conflictReport.falsePositives.map((entry) => entry.fingerprint),
      ...conflictReport.conflicts.map((entry) => entry.fingerprint),
    ]);
    const seenFingerprints = new Set<string>();
    const malware = malwareLanes
      .flatMap((lane) => lane.items)
      .filter((item) => {
        const fingerprint = malwareFingerprint(item);
        if (excludedFingerprints.has(fingerprint) || seenFingerprints.has(fingerprint))
          return false;
        seenFingerprints.add(fingerprint);
        return true;
      });
    return { conflictReport, malware };
  }

  private buildVulnerabilities(
    legacyVulns: Vulnerability[],
    crossReport: CrossValidationReport,
  ): Vulnerability[] {
    return [...legacyVulns, ...mapCrossEntries(crossReport)];
  }
}

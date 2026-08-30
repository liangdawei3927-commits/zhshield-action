/**
 * AI 代码审查门面（review.ts）
 *
 * 附 E.3 AiCodeReview 契约 + E.4 三层交付映射：
 * - 免费层 detectOrigin：检测标记（多信号证据）
 * - Pro 层 deepReview + suggestFix：幻觉依赖 + 不安全模式规则集 → 07 协议修复闭环
 * - 企业层 complianceReport：合规报告（AI 代码占比 + 风险分布 + 审计日志）
 */
import type { ProjectProfile } from '@zh/dependency';

import { isInScope, readTextFileSafe, walkSourceFiles } from './files';
import { HallucinatedDependencyCheckImpl } from './hallucinated-dependency';
import { AiOriginDetectorImpl } from './origin-detector';
import type { AiOriginDetector } from './origin-detector';
import { PATTERN_RULES } from './pattern-rules';
import type {
  AiAuditEntry,
  AiCodeReview,
  AiCodeVuln,
  AiComplianceReport,
  AiOriginFinding,
  AiToolReport,
  AiUserTag,
  AiVulnSeverity,
} from './types';

/** 审查输入信号（可选的确定性证据） */
export interface AiReviewOptions {
  userTags?: readonly AiUserTag[];
  toolReports?: readonly AiToolReport[];
}

/** 幻觉依赖 → 漏洞严重度映射（附 E.3：抢注即 critical） */
const HALLUCINATED_SEVERITY: Record<AiCodeVuln['ruleId'], Record<string, AiVulnSeverity>> = {
  'ai-hallucinated-dependency': {
    'typosquat-similar': 'critical',
    'not-found': 'high',
    'unverified-offline': 'medium',
  },
  'ai-unsafe-default': {},
  'ai-boundary-miss': {},
};

const SEVERITY_RANK: Record<AiVulnSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** AI 代码审查实现：免费/Pro/企业三层能力 */
export class AiCodeReviewImpl implements AiCodeReview {
  private readonly originDetector: AiOriginDetector;
  private readonly hallucinatedCheck: HallucinatedDependencyCheckImpl;

  constructor() {
    this.originDetector = new AiOriginDetectorImpl();
    this.hallucinatedCheck = new HallucinatedDependencyCheckImpl();
  }

  /** 免费层：检测标记（多信号证据，E.5） */
  async detectOrigin(project: ProjectProfile): Promise<readonly AiOriginFinding[]> {
    return this.originDetector.detect(project);
  }

  /** Pro 层：深度审查（幻觉依赖 + 不安全模式规则集），scope 限制扫描范围 */
  async deepReview(project: ProjectProfile, opts: { readonly scope?: readonly string[] } = {}): Promise<readonly AiCodeVuln[]> {
    const projectPath = project.projectPath;
    const scope = opts.scope;
    const vulns: AiCodeVuln[] = [];

    vulns.push(...(await this.collectHallucinations(project, scope)));
    vulns.push(...this.collectPatternVulns(projectPath, scope));
    this.sortVulns(vulns);
    return vulns;
  }

  /** 收集幻觉依赖漏洞（附 B 协同：抢注 → critical） */
  private async collectHallucinations(project: ProjectProfile, scope: readonly string[] | undefined): Promise<AiCodeVuln[]> {
    const vulns: AiCodeVuln[] = [];
    const hallucinations = await this.hallucinatedCheck.check(project);
    for (const h of hallucinations) {
      const first = h.referencedFrom[0];
      if (first === undefined) continue;
      if (!isInScope(first.file, scope)) continue;
      const severity = HALLUCINATED_SEVERITY['ai-hallucinated-dependency'][h.registryStatus] ?? 'medium';
      vulns.push({
        vulnId: `ai-hallucinated-${h.packageName}`,
        ruleId: 'ai-hallucinated-dependency',
        file: first.file,
        line: first.line,
        severity,
        description: `import '${h.packageName}' is referenced but absent from the local dependency closure (${h.registryStatus})`,
        fix: `Verify the package name on the registry; install the real package or remove the unused import`,
      });
    }
    return vulns;
  }

  /** 逐文件扫描不安全模式规则集 */
  private collectPatternVulns(projectPath: string, scope: readonly string[] | undefined): AiCodeVuln[] {
    const vulns: AiCodeVuln[] = [];
    for (const file of walkSourceFiles(projectPath)) {
      if (!isInScope(file, scope)) continue;
      const content = readTextFileSafe(projectPath, file);
      if (content === null) continue;
      for (const rule of PATTERN_RULES) {
        for (const hit of rule.match(content)) {
          vulns.push({
            vulnId: `${rule.id}-${file}-${hit.line}`,
            ruleId: rule.ruleId,
            file,
            line: hit.line,
            severity: rule.severity,
            description: rule.description,
            fix: rule.fix,
          });
        }
      }
    }
    return vulns;
  }

  /** 按严重度 → 文件 → 行号排序 */
  private sortVulns(vulns: AiCodeVuln[]): void {
    vulns.sort((a, b) => {
      const rankDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rankDiff !== 0) return rankDiff;
      const fileDiff = a.file.localeCompare(b.file);
      if (fileDiff !== 0) return fileDiff;
      return a.line - b.line;
    });
  }

  /** Pro 层：修复建议（07 协议直接消费） */
  async suggestFix(vuln: AiCodeVuln): Promise<string> {
    return vuln.fix;
  }

  /** 企业层：合规报告 + 审计日志（策略 violation MVP 恒为空，E.2） */
  async complianceReport(project: ProjectProfile): Promise<AiComplianceReport> {
    const projectPath = project.projectPath;
    const generatedAt = new Date().toISOString();

    const aiCodeRatio = await this.computeAiCodeRatio(project);
    const riskByModule = await this.computeRiskByModule(project);
    const auditLog = this.buildAuditLog(generatedAt, projectPath);

    return this.buildComplianceReport(generatedAt, aiCodeRatio, riskByModule, auditLog);
  }

  /** 组装合规报告对象（MVP 无历史基线 / 不配置策略） */
  private buildComplianceReport(
    generatedAt: string,
    aiCodeRatio: number,
    riskByModule: { module: string; vulnCount: number }[],
    auditLog: AiAuditEntry[],
  ): AiComplianceReport {
    return {
      generatedAt,
      aiCodeRatio,
      trend: { period: 'week', delta: 0 }, // MVP 无历史基线，delta=0
      riskByModule,
      auditLog,
      policyViolations: [], // MVP 不配置策略（E.2：violation 检出留待策略下发）
    };
  }

  /** 计算 AI 代码占比（基于标记结果，边界 1：不是概率黑盒） */
  private async computeAiCodeRatio(project: ProjectProfile): Promise<number> {
    const findings = await this.originDetector.detect(project);
    const markedFiles = new Set(findings.filter((f) => f.strength !== 'uncertain').map((f) => f.file)).size;
    const totalFiles = walkSourceFiles(project.projectPath).length;
    return totalFiles === 0 ? 0 : markedFiles / totalFiles;
  }

  /** 按模块（路径首段）聚合深度审查漏洞 */
  private async computeRiskByModule(project: ProjectProfile): Promise<{ module: string; vulnCount: number }[]> {
    const vulns = await this.deepReview(project, {});
    const byModule = new Map<string, number>();
    for (const v of vulns) {
      const module = v.file.split('/')[0] ?? '';
      byModule.set(module, (byModule.get(module) ?? 0) + 1);
    }
    return Array.from(byModule.entries(), ([module, vulnCount]) => ({ module, vulnCount }))
      .sort((a, b) => b.vulnCount - a.vulnCount || a.module.localeCompare(b.module));
  }

  /** 构建审计日志：谁 / 何时 / 哪些文件被审查 */
  private buildAuditLog(generatedAt: string, projectPath: string): AiAuditEntry[] {
    return [
      {
        at: generatedAt,
        action: 'ai-code-review',
        scope: projectPath,
        actor: 'ai-code-reviewer',
      },
    ];
  }
}

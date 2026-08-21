import { randomUUID } from 'node:crypto';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { Issue, ToolOutputMapper } from './types';

// ─── 工具原始输出类型（仅声明 mapper 实际读取的字段）─────────
// 外部工具输出为 JSON，入口处断言 + 运行时守卫（Array.isArray 等）保证安全。

interface EslintFile {
  filePath?: string;
  messages?: Array<{
    ruleId?: string;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
    fix?: unknown;
    suggestions?: Array<{ desc?: string }>;
  }>;
}

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  extra?: {
    severity?: string;
    message?: string;
    fix?: string;
    metadata?: { description?: string };
  };
}
interface SemgrepOutput { results?: SemgrepResult[] }

interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Title?: string;
  Severity?: string;
}
interface TrivySecret {
  RuleID?: string;
  Title?: string;
  File?: string;
  StartLine?: number;
}
interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Secrets?: TrivySecret[];
}
interface TrivyOutput { Results?: TrivyResult[] }

interface GrypeMatch {
  vulnerability?: { id?: string; severity?: string; description?: string; fixedInVersion?: string };
  artifact?: { name?: string; version?: string };
}
interface GrypeOutput { matches?: GrypeMatch[] }

interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  StartColumn?: number;
}

interface DepcheckOutput {
  dependencies?: string[];
  devDependencies?: string[];
}

interface DepCruiserViolation {
  rule?: { name?: string; severity?: string };
  from?: { path?: string; line?: number };
  to?: { path?: string };
}
interface DepCruiserOutput { summary?: { violations?: DepCruiserViolation[] } }

interface JscpdDuplicate {
  format?: string;
  first?: { location?: { path?: string; start?: { line?: number } }; path?: string; position?: { start?: { line?: number } } };
  second?: { location?: { path?: string }; path?: string };
}
interface JscpdOutput { duplicates?: JscpdDuplicate[] }

// ─── Mappers ──────────────────────────────────────────────

export const eslintMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  if (!Array.isArray(output)) return [];
  const issues: Issue[] = [];
  for (const file of output as EslintFile[]) {
    if (!file?.messages || !Array.isArray(file.messages)) continue;
    for (const msg of file.messages) {
      if (!msg.ruleId) continue;
      issues.push({
        id: randomUUID(),
        ruleId: msg.ruleId,
        severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
        category: 'quality',
        message: msg.message || `ESLint: ${msg.ruleId}`,
        file: file.filePath || '',
        line: msg.line || 0,
        column: msg.column || 0,
        suggestion: msg.fix ? translate('engine.output.autoFixable', locale ?? DEFAULT_LANGUAGE) : msg.suggestions?.map((s) => s.desc).join('; ') || undefined,
        autoFixable: !!msg.fix,
        source: 'inspect',
        fingerprint: `${msg.ruleId}:${file.filePath || ''}:${msg.line || 0}`,
      });
    }
  }
  return issues;
};

export const semgrepMapper: ToolOutputMapper = (output: unknown): Issue[] => {
  const data = output as SemgrepOutput | undefined;
  if (!data?.results || !Array.isArray(data.results)) return [];
  return data.results.map((r) => ({
    id: randomUUID(),
    ruleId: `semgrep.${r.check_id || 'unknown'}`,
    severity: r.extra?.severity === 'ERROR' ? 'error' : r.extra?.severity === 'WARNING' ? 'warning' : 'info',
    category: 'security',
    message: r.extra?.message || r.extra?.metadata?.description || `Semgrep: ${r.check_id}`,
    file: r.path || '',
    line: r.start?.line || 0,
    column: r.start?.col || 0,
    suggestion: r.extra?.fix || undefined,
    autoFixable: !!r.extra?.fix,
    source: 'security',
    fingerprint: `semgrep:${r.check_id || ''}:${r.path || ''}:${r.start?.line || 0}`,
  }));
};

export const trivyMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  const data = output as TrivyOutput | undefined;
  if (!data?.Results || !Array.isArray(data.Results)) return [];
  const issues: Issue[] = [];
  for (const result of data.Results) {
    if (result.Vulnerabilities && Array.isArray(result.Vulnerabilities)) {
      for (const vuln of result.Vulnerabilities) {
        const sev = (vuln.Severity || '').toUpperCase();
        issues.push({
          id: randomUUID(),
          ruleId: vuln.VulnerabilityID || 'trivy-unknown',
          severity: sev === 'CRITICAL' || sev === 'HIGH' ? 'error' : sev === 'MEDIUM' ? 'warning' : 'info',
          category: 'security',
          message: `${vuln.PkgName || '?'}@${vuln.InstalledVersion || '?'}: ${vuln.Title || vuln.VulnerabilityID || ''}`,
          file: result.Target || '',
          line: 0,
          column: 0,
          suggestion: vuln.FixedVersion ? translate('engine.output.upgradeTo', locale ?? DEFAULT_LANGUAGE, { version: vuln.FixedVersion }) : undefined,
          autoFixable: !!vuln.FixedVersion,
          source: 'security',
          fingerprint: `trivy:${vuln.VulnerabilityID || ''}:${result.Target || ''}:${vuln.PkgName || ''}`,
        });
      }
    }
    if (result.Secrets && Array.isArray(result.Secrets)) {
      for (const secret of result.Secrets) {
        issues.push({
          id: randomUUID(),
          ruleId: `trivy-secret-${secret.RuleID || 'unknown'}`,
          severity: 'error',
          category: 'security',
          message: secret.Title || `Secret detected: ${secret.RuleID}`,
          file: secret.File || result.Target || '',
          line: secret.StartLine || 0,
          column: 0,
          suggestion: translate('engine.output.removeHardcodedSecret', locale ?? DEFAULT_LANGUAGE),
          autoFixable: false,
          source: 'security',
          fingerprint: `trivy-secret:${secret.RuleID || ''}:${secret.File || ''}:${secret.StartLine || 0}`,
        });
      }
    }
  }
  return issues;
};

export const grypeMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  const data = output as GrypeOutput | undefined;
  if (!data?.matches || !Array.isArray(data.matches)) return [];
  return data.matches.map((m) => {
    const sev = (m.vulnerability?.severity || '').toLowerCase();
    return {
      id: randomUUID(),
      ruleId: m.vulnerability?.id || 'grype-unknown',
      severity: sev === 'critical' || sev === 'high' ? 'error' : sev === 'medium' ? 'warning' : 'info',
      category: 'security',
      message: `${m.artifact?.name || '?'}@${m.artifact?.version || '?'}: ${m.vulnerability?.description || m.vulnerability?.id || ''}`,
      file: '',
      line: 0,
      column: 0,
      suggestion: m.vulnerability?.fixedInVersion ? translate('engine.output.upgradeTo', locale ?? DEFAULT_LANGUAGE, { version: m.vulnerability.fixedInVersion }) : undefined,
      autoFixable: !!m.vulnerability?.fixedInVersion,
      source: 'security',
      fingerprint: `grype:${m.vulnerability?.id || ''}:${m.artifact?.name || ''}`,
    };
  });
};

export const gitleaksMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  if (!Array.isArray(output)) return [];
  return (output as GitleaksFinding[]).map((f) => ({
    id: randomUUID(),
    ruleId: f.RuleID || 'gitleaks-unknown',
    severity: 'error',
    category: 'security',
    message: f.Description || `Gitleaks: ${f.RuleID}`,
    file: f.File || '',
    line: f.StartLine || 0,
    column: f.StartColumn || 0,
    suggestion: translate('engine.output.removeHardcodedKey', locale ?? DEFAULT_LANGUAGE),
    autoFixable: false,
    source: 'inspect',
    fingerprint: `gitleaks:${f.RuleID || ''}:${f.File || ''}:${f.StartLine || 0}`,
  }));
};

export const depcheckMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  const data = output as DepcheckOutput | undefined;
  if (!data || typeof data !== 'object') return [];
  const issues: Issue[] = [];
  const deps: string[] = data.dependencies || [];
  const devDeps: string[] = data.devDependencies || [];
  for (const name of deps) {
    issues.push({
      id: randomUUID(),
      ruleId: 'depcheck/unused-dep',
      severity: 'info',
      category: 'quality',
      message: translate('engine.output.unusedProdDependency', locale ?? DEFAULT_LANGUAGE, { name }),
      file: 'package.json',
      line: 0,
      column: 0,
      suggestion: translate('engine.output.removeDependency', locale ?? DEFAULT_LANGUAGE, { name }),
      autoFixable: false,
      source: 'security',
      fingerprint: `depcheck:${name}:dependencies`,
    });
  }
  for (const name of devDeps) {
    issues.push({
      id: randomUUID(),
      ruleId: 'depcheck/unused-dev-dep',
      severity: 'info',
      category: 'quality',
      message: translate('engine.output.unusedDevDependency', locale ?? DEFAULT_LANGUAGE, { name }),
      file: 'package.json',
      line: 0,
      column: 0,
      suggestion: translate('engine.output.removeDevDependency', locale ?? DEFAULT_LANGUAGE, { name }),
      autoFixable: false,
      source: 'security',
      fingerprint: `depcheck:${name}:devDependencies`,
    });
  }
  return issues;
};

export const depCruiserMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  const data = output as DepCruiserOutput | undefined;
  if (!data?.summary?.violations || !Array.isArray(data.summary.violations)) return [];
  return data.summary.violations.map((v) => ({
    id: randomUUID(),
    ruleId: v.rule?.name || 'dep-cruiser/violation',
    severity: v.rule?.severity === 'error' ? 'error' : v.rule?.severity === 'warn' ? 'warning' : 'info',
    category: 'architecture',
    message: translate('engine.output.architectureViolation', locale ?? DEFAULT_LANGUAGE, {
      rule: v.rule?.name || translate('engine.output.unknownRule', locale ?? DEFAULT_LANGUAGE),
      from: v.from?.path || '?',
      to: v.to?.path || '?',
    }),
    file: v.from?.path || '',
    line: v.from?.line || 0,
    column: 0,
    suggestion: translate('engine.output.moduleShouldNotReference', locale ?? DEFAULT_LANGUAGE, {
      from: v.from?.path || '',
      to: v.to?.path || '',
    }),
    autoFixable: false,
    source: 'inspect',
    fingerprint: `dep-cruiser:${v.rule?.name || ''}:${v.from?.path || ''}:${v.to?.path || ''}`,
  }));
};

export const jscpdMapper = (output: unknown, locale?: LanguageCode): Issue[] => {
  const data = output as JscpdOutput | undefined;
  if (!data?.duplicates || !Array.isArray(data.duplicates)) return [];
  return data.duplicates.map((d, idx: number) => {
    const firstFile = d.first?.location?.path || d.first?.path || '';
    const firstLines = d.first?.location?.start?.line || d.first?.position?.start?.line || 0;
    const secondFile = d.second?.location?.path || d.second?.path || '';
    const format = d.format || 'code';
    return {
      id: randomUUID(),
      ruleId: 'jscpd/duplicate',
      severity: 'warning',
      category: 'quality',
      message: translate('engine.output.duplicateCode', locale ?? DEFAULT_LANGUAGE, {
        format,
        firstFile,
        firstLines,
        secondFile: secondFile || '?',
      }),
      file: firstFile,
      line: firstLines,
      column: 0,
      suggestion: translate('engine.output.extractSharedCode', locale ?? DEFAULT_LANGUAGE, { secondFile }),
      autoFixable: false,
      source: 'inspect',
      fingerprint: `jscpd:${idx}:${firstFile}:${firstLines}`,
    };
  });
};

export const toolMappers: Record<string, ToolOutputMapper> = {
  eslint: eslintMapper,
  semgrep: semgrepMapper,
  trivy: trivyMapper,
  grype: grypeMapper,
  gitleaks: gitleaksMapper,
  depcheck: depcheckMapper,
  'dep-cruiser': depCruiserMapper,
  jscpd: jscpdMapper,
};

import { randomUUID } from 'node:crypto';
import type { Issue, ToolOutputMapper } from './types';

// ─── 工具原始输出类型（仅声明 mapper 实际读取的字段）─────────
// 外部工具输出为 JSON，入口处断言 + 运行时守卫（Array.isArray 等）保证安全。
// 这组类型是全仓工具输出结构的**唯一来源**：@zh/security 的 tool-output-types
// 原样重导出它们，故新增字段只改此处。

/** ESLint 单文件结果：命中列表与修复/建议载荷 */
export interface EslintFile {
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

/** Semgrep 单条匹配：规则 ID、命中位置与 extra 元信息（severity / message / fix / 污点链） */
export interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  extra?: {
    severity?: string;
    message?: string;
    fix?: string;
    metadata?: { description?: string };
    /** dataflow_trace 的 extra 嵌套变体（部分包装器输出），兼容读取 */
    dataflow_trace?: SemgrepDataflowTrace;
  };
  /** 污点数据流链（SARIF codeFlows 子集），仅 join_mode/trace 规则输出 */
  dataflow_trace?: SemgrepDataflowTrace;
}

/** Semgrep JSON 输出顶层结构：results 为规则匹配列表（缺 results 表示零匹配） */
export interface SemgrepOutput {
  results?: SemgrepResult[];
}

/** 污点数据流链容器（SARIF codeFlows 子集）：仅 join_mode / trace 类规则输出 */
export interface SemgrepDataflowTrace {
  code_flows?: SemgrepCodeFlow[];
}

/** 单条代码流：内含线程流列表 */
export interface SemgrepCodeFlow {
  thread_flows?: SemgrepThreadFlow[];
}

/** 单条线程流：污点传播依次经过的位置序列 */
export interface SemgrepThreadFlow {
  locations?: SemgrepFlowLocation[];
}

/** 流中的一个位置节点：文件路径 + 行列，并携带该步的说明文案 */
export interface SemgrepFlowLocation {
  /** 部分条目可能缺失 location 子对象，映射时需跳过 */
  location?: { path?: string; start?: { line?: number; col?: number } };
  message?: string;
}

/** Trivy 单条漏洞：包坐标 + 已装/修复版本 + 原始严重级别与标题 */
export interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Title?: string;
  Severity?: string;
}

/** Trivy 单条密钥命中：规则 ID + 所在文件与起始行 */
export interface TrivySecret {
  RuleID?: string;
  Title?: string;
  File?: string;
  StartLine?: number;
}

/** Trivy 单个扫描目标的结果分组：漏洞与密钥命中分别挂在 Vulnerabilities / Secrets */
export interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Secrets?: TrivySecret[];
}

/** Trivy JSON 输出顶层结构：Results 按扫描目标（文件系统 / 依赖清单等）分组 */
export interface TrivyOutput {
  Results?: TrivyResult[];
}

/** Grype 单条匹配：漏洞元信息（id/严重级别/描述/修复版本）+ 受影响构件（包名@版本） */
export interface GrypeMatch {
  vulnerability?: { id?: string; severity?: string; description?: string; fixedInVersion?: string };
  artifact?: { name?: string; version?: string };
}

/** Grype JSON 输出顶层结构：matches 为漏洞匹配列表 */
export interface GrypeOutput {
  matches?: GrypeMatch[];
}

/** Gitleaks 单条密钥命中：规则 ID、说明文案、文件与起止行列 */
export interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  StartColumn?: number;
}

/** Depcheck JSON 输出：未被引用（可删除）的运行时 / 开发依赖包名列表 */
export interface DepcheckOutput {
  dependencies?: string[];
  devDependencies?: string[];
}

/** dependency-cruiser 单条架构违规：规则名/严重级别 + 违规来源与目标 */
export interface DepCruiserViolation {
  rule?: { name?: string; severity?: string };
  from?: { path?: string; line?: number };
  to?: { path?: string };
}

/** dependency-cruiser JSON 输出顶层结构：违规列表挂在 summary.violations */
export interface DepCruiserOutput {
  summary?: { violations?: DepCruiserViolation[] };
}

/** jscpd 单条重复块：两处位置 + 重复代码格式（语言/扩展名） */
export interface JscpdDuplicate {
  format?: string;
  first?: {
    location?: { path?: string; start?: { line?: number } };
    path?: string;
    position?: { start?: { line?: number } };
  };
  second?: { location?: { path?: string }; path?: string };
}

/** jscpd JSON 输出顶层结构：duplicates 为重复代码块列表 */
export interface JscpdOutput {
  duplicates?: JscpdDuplicate[];
}

// ─── Mappers ──────────────────────────────────────────────

export const eslintMapper: ToolOutputMapper = (output: unknown): Issue[] => {
  if (!Array.isArray(output)) return [];
  const issues: Issue[] = [];
  for (const file of output as EslintFile[]) {
    if (!file?.messages || !Array.isArray(file.messages)) continue;
    for (const msg of file.messages) {
      if (!msg.ruleId) continue;
      const suggestion = msg.fix
        ? '可自动修复'
        : msg.suggestions?.map((s) => s.desc).join('; ') || undefined;
      issues.push({
        id: randomUUID(),
        ruleId: msg.ruleId,
        severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
        category: 'quality',
        message: msg.message || `ESLint: ${msg.ruleId}`,
        file: file.filePath || '',
        line: msg.line || 0,
        column: msg.column || 0,
        ...(suggestion ? { suggestion } : {}),
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
    severity:
      r.extra?.severity === 'ERROR'
        ? 'error'
        : r.extra?.severity === 'WARNING'
          ? 'warning'
          : 'info',
    category: 'security',
    message: r.extra?.message || r.extra?.metadata?.description || `Semgrep: ${r.check_id}`,
    file: r.path || '',
    line: r.start?.line || 0,
    column: r.start?.col || 0,
    ...(r.extra?.fix ? { suggestion: r.extra.fix } : {}),
    autoFixable: !!r.extra?.fix,
    source: 'security',
    fingerprint: `semgrep:${r.check_id || ''}:${r.path || ''}:${r.start?.line || 0}`,
  }));
};

export const trivyMapper: ToolOutputMapper = (output: unknown): Issue[] => {
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
          severity:
            sev === 'CRITICAL' || sev === 'HIGH' ? 'error' : sev === 'MEDIUM' ? 'warning' : 'info',
          category: 'security',
          message: `${vuln.PkgName || '?'}@${vuln.InstalledVersion || '?'}: ${vuln.Title || vuln.VulnerabilityID || ''}`,
          file: result.Target || '',
          line: 0,
          column: 0,
          ...(vuln.FixedVersion ? { suggestion: `升级到 ${vuln.FixedVersion}` } : {}),
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
          suggestion: '移除硬编码的密钥，使用环境变量或密钥管理服务',
          autoFixable: false,
          source: 'security',
          fingerprint: `trivy-secret:${secret.RuleID || ''}:${secret.File || ''}:${secret.StartLine || 0}`,
        });
      }
    }
  }
  return issues;
};

export const grypeMapper: ToolOutputMapper = (output: unknown): Issue[] => {
  const data = output as GrypeOutput | undefined;
  if (!data?.matches || !Array.isArray(data.matches)) return [];
  return data.matches.map((m) => {
    const sev = (m.vulnerability?.severity || '').toLowerCase();
    return {
      id: randomUUID(),
      ruleId: m.vulnerability?.id || 'grype-unknown',
      severity:
        sev === 'critical' || sev === 'high' ? 'error' : sev === 'medium' ? 'warning' : 'info',
      category: 'security',
      message: `${m.artifact?.name || '?'}@${m.artifact?.version || '?'}: ${m.vulnerability?.description || m.vulnerability?.id || ''}`,
      file: '',
      line: 0,
      column: 0,
      ...(m.vulnerability?.fixedInVersion
        ? { suggestion: `升级到 ${m.vulnerability.fixedInVersion}` }
        : {}),
      autoFixable: !!m.vulnerability?.fixedInVersion,
      source: 'security',
      fingerprint: `grype:${m.vulnerability?.id || ''}:${m.artifact?.name || ''}`,
    };
  });
};

export const gitleaksMapper: ToolOutputMapper = (output: unknown): Issue[] => {
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
    suggestion: '移除硬编码密钥，使用环境变量或密钥管理服务',
    autoFixable: false,
    source: 'inspect',
    fingerprint: `gitleaks:${f.RuleID || ''}:${f.File || ''}:${f.StartLine || 0}`,
  }));
};

export const depcheckMapper: ToolOutputMapper = (output: unknown): Issue[] => {
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
      message: `未使用的生产依赖: ${name}`,
      file: 'package.json',
      line: 0,
      column: 0,
      suggestion: `移除 ${name} 从 dependencies`,
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
      message: `未使用的开发依赖: ${name}`,
      file: 'package.json',
      line: 0,
      column: 0,
      suggestion: `移除 ${name} 从 devDependencies`,
      autoFixable: false,
      source: 'security',
      fingerprint: `depcheck:${name}:devDependencies`,
    });
  }
  return issues;
};

export const depCruiserMapper: ToolOutputMapper = (output: unknown): Issue[] => {
  const data = output as DepCruiserOutput | undefined;
  if (!data?.summary?.violations || !Array.isArray(data.summary.violations)) return [];
  return data.summary.violations.map((v) => ({
    id: randomUUID(),
    ruleId: v.rule?.name || 'dep-cruiser/violation',
    severity:
      v.rule?.severity === 'error' ? 'error' : v.rule?.severity === 'warn' ? 'warning' : 'info',
    category: 'architecture',
    message: `架构边界违规: ${v.rule?.name || '未知规则'} - ${v.from?.path || '?'} → ${v.to?.path || '?'}`,
    file: v.from?.path || '',
    line: v.from?.line || 0,
    column: 0,
    suggestion: `模块 ${v.from?.path || ''} 不应引用 ${v.to?.path || ''}`,
    autoFixable: false,
    source: 'inspect',
    fingerprint: `dep-cruiser:${v.rule?.name || ''}:${v.from?.path || ''}:${v.to?.path || ''}`,
  }));
};

export const jscpdMapper: ToolOutputMapper = (output: unknown): Issue[] => {
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
      message: `发现重复代码 (${format}): ${firstFile}:${firstLines} ↔ ${secondFile || '?'}`,
      file: firstFile,
      line: firstLines,
      column: 0,
      suggestion: `提取公共代码到共享模块 (重复位置: ${secondFile})`,
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

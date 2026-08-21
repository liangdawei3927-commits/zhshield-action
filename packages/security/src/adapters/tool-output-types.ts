/**
 * 外部工具 JSON 输出的类型定义
 *
 * 这些接口描述了 Trivy / Semgrep / Grype / Depcheck / npm audit 等
 * 外部 CLI 工具的 JSON 输出结构，替代 mapOutput / mapVulnerability 等方法中的 any 类型。
 * 只声明代码实际访问的字段，未使用的字段省略。
 */

// ─── execFile 错误类型 ─────────────────────────────────

/** execFile / execFileAsync 抛出的错误结构 */
export interface ExecError extends Error {
  code?: string;
  stderr?: string;
  stdout?: string;
}

// ─── Trivy 输出 ────────────────────────────────────────

export interface TrivyOutput {
  Results?: TrivyResult[];
}

export interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVulnerability[];
  Secrets?: TrivySecret[];
}

export interface TrivyVulnerability {
  VulnerabilityID?: string;
  PkgName?: string;
  InstalledVersion?: string;
  FixedVersion?: string;
  Severity?: string;
  Title?: string;
}

export interface TrivySecret {
  RuleID?: string;
  Title?: string;
  File?: string;
  StartLine?: number;
}

// ─── Semgrep 输出 ──────────────────────────────────────

export interface SemgrepOutput {
  results?: SemgrepResult[];
}

export interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number; col?: number };
  extra?: {
    severity?: string;
    message?: string;
    fix?: string;
    metadata?: { description?: string };
  };
  /** 污点数据流链（SARIF codeFlows 子集），仅 join_mode/trace 规则输出 */
  dataflow_trace?: SemgrepDataflowTrace;
}

export interface SemgrepDataflowTrace {
  code_flows?: SemgrepCodeFlow[];
}

export interface SemgrepCodeFlow {
  thread_flows?: SemgrepThreadFlow[];
}

export interface SemgrepThreadFlow {
  locations?: SemgrepFlowLocation[];
}

export interface SemgrepFlowLocation {
  /** 部分条目可能缺失 location 子对象，映射时需跳过 */
  location?: { path?: string; start?: { line?: number; col?: number } };
  message?: string;
}

// ─── Grype 输出 ────────────────────────────────────────

export interface GrypeOutput {
  matches?: GrypeMatch[];
}

export interface GrypeMatch {
  vulnerability?: {
    id?: string;
    severity?: string;
    description?: string;
    fixedInVersion?: string;
  };
  artifact?: {
    name?: string;
    version?: string;
  };
}

// ─── Depcheck 输出 ─────────────────────────────────────

export interface DepcheckOutput {
  dependencies?: string[];
  devDependencies?: string[];
}

// ─── npm audit 输出 ────────────────────────────────────

export interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

export interface NpmAuditVulnerability {
  severity?: string;
  version?: string;
  range?: string;
  isDirect?: boolean;
  fixAvailable?: string | boolean;
  via?: Array<{ title?: string } | string>;
}

// ─── poetry audit 输出 ────────────────────────────────

export interface PoetryAuditOutput {
  vulnerabilities?: Array<{
    name?: string;
    version?: string;
    advisory?: string;
    severity?: string;
    fixed_versions?: string[];
  }>;
}

// ─── pip-audit 输出 ───────────────────────────────────

export interface PipAuditOutput {
  dependencies?: Array<{
    name?: string;
    version?: string;
    vulns?: Array<{
      id?: string;
      advisory?: string;
      aliases?: string[];
      fix_versions?: string[];
    }>;
  }>;
}

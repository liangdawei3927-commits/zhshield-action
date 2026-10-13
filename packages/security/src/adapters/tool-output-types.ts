/**
 * 外部工具 JSON 输出的类型定义
 *
 * 这些接口描述了 Trivy / Semgrep / Grype / Depcheck / npm audit 等
 * 外部 CLI 工具的 JSON 输出结构，替代 mapOutput / mapVulnerability 等方法中的 any 类型。
 * 只声明代码实际访问的字段，未使用的字段省略。
 *
 * Trivy / Semgrep / Grype / Depcheck 四组结构与 @zh/shared 的 output-mappers 逐字段
 * 同构，已收敛到该处作为全仓唯一来源；此处原样重导出，既有导入路径保持可用。
 */

export type {
  TrivyOutput,
  TrivyResult,
  TrivyVulnerability,
  TrivySecret,
  SemgrepOutput,
  SemgrepResult,
  GrypeOutput,
  DepcheckOutput,
} from '@zh/shared';

// ─── execFile 错误类型 ─────────────────────────────────

/** execFile / execFileAsync 抛出的错误结构 */
export interface ExecError extends Error {
  code?: string;
  stderr?: string;
  stdout?: string;
}

// ─── npm audit 输出 ────────────────────────────────────

/** npm audit JSON 输出：vulnerabilities 为「包名 → 漏洞详情」映射 */
export interface NpmAuditOutput {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

/** npm audit 单条漏洞：严重级别、受影响版本区间（version/range）、是否直接依赖、
 *  fixAvailable 为修复版本号或布尔标记，via 列出直接漏洞标题或传递依赖名 */
export interface NpmAuditVulnerability {
  severity?: string;
  version?: string;
  range?: string;
  isDirect?: boolean;
  fixAvailable?: string | boolean;
  via?: Array<{ title?: string } | string>;
}

// ─── poetry audit 输出 ────────────────────────────────

/** poetry audit JSON 输出：vulnerabilities 为扁平漏洞数组（包名/版本/advisory/修复版本） */
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

/** pip-audit JSON 输出：dependencies 按包聚合，vulns 内嵌该包命中的漏洞 ID、
 *  advisory、别名与可修复版本列表 */
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

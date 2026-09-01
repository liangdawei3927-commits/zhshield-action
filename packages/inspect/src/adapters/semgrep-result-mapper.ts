import { randomUUID } from 'node:crypto';
import type { Issue, IssueCategory, CodeFlow, CodeFlowLocation } from '@zh/shared';

/** Semgrep 输出中的位置（dataflow_trace 内部复用） */
interface SemgrepLocation {
  path?: string;
  start?: { line?: number; col?: number; column?: number };
}

/** Semgrep JSON 输出中的单条结果 */
export interface SemgrepResult {
  check_id?: string;
  rule?: { id?: string };
  severity?: string;
  path?: string;
  start?: { line?: number; col?: number; column?: number };
  /**
   * taint 数据流追踪：source → intermediate_vars → sink。
   * 真实 Semgrep JSON 把 dataflow_trace 放在 result 顶层；部分包装器会嵌到 extra 下，两处都接受。
   */
  dataflow_trace?: {
    taint_source?: { location?: SemgrepLocation };
    intermediate_vars?: Array<{ var_name?: string; location?: SemgrepLocation }>;
    taint_sink?: { location?: SemgrepLocation };
  };
  extra?: {
    severity?: string;
    message?: string;
    fix?: string;
    metadata?: { fix?: string };
    /** taint 数据流追踪（extra 嵌套变体，兼容读取） */
    dataflow_trace?: {
      taint_source?: { location?: SemgrepLocation };
      intermediate_vars?: Array<{ var_name?: string; location?: SemgrepLocation }>;
      taint_sink?: { location?: SemgrepLocation };
    };
    /** Semgrep 验证状态：NO_VALIDATOR / CONFIRMED / REJECTED / UNCONFIRMED */
    validation_state?: string;
    /** 供应链可达性信息（supply-chain mode 输出） */
    sca_info?: {
      reachable?: boolean;
      sca_kind?: string;
    };
  };
  message?: string;
}

/** Semgrep JSON 输出中的单条错误（如无效扫描目标、规则解析失败） */
export interface SemgrepError {
  code?: number;
  level?: string;
  type?: string;
  message?: string;
}

/** Semgrep JSON 输出结构 */
export interface SemgrepOutput {
  results?: SemgrepResult[];
  errors?: SemgrepError[];
}

/**
 * SemgrepResultMapper — 将 Semgrep JSON 输出映射为统一的 Issue 结构
 */
export class SemgrepResultMapper {
  mapOutput(output: SemgrepOutput, category: IssueCategory = 'security'): Issue[] {
    const results = output?.results;
    if (!Array.isArray(results)) return [];

    return results.map((r) => this.mapResult(r, category));
  }

  private mapResult(r: SemgrepResult, category: IssueCategory): Issue {
    const ruleId = this.resolveRuleId(r);
    const fix = this.resolveFix(r);
    const loc = this.resolveLocation(r);

    return {
      id: randomUUID(),
      ruleId,
      severity: this.normalizeSeverity(r.extra?.severity || r.severity || 'WARNING'),
      category,
      message: this.resolveMessage(r, ruleId),
      file: loc.file,
      line: loc.line,
      column: loc.column,
      suggestion: fix,
      autoFixable: !!fix,
      source: 'inspect',
      fingerprint: this.resolveFingerprint(ruleId, loc),
      codeFlows: this.resolveCodeFlows(r),
      taxonomies: this.resolveTaxonomies(r),
    };
  }

  /**
   * 将 dataflow_trace 映射为 SARIF-compatible codeFlows：
   * taint_source → intermediate_vars → taint_sink 的 locations 链
   */
  private resolveCodeFlows(r: SemgrepResult): CodeFlow[] | undefined {
    const trace = r.dataflow_trace ?? r.extra?.dataflow_trace;
    if (!trace) return undefined;

    const locations = this.collectTraceLocations(trace);
    if (locations.length === 0) return undefined;
    return [{ threadFlows: [{ locations }] }];
  }

  /** 收集 taint_source → intermediate_vars → taint_sink 的 locations 链 */
  private collectTraceLocations(
    trace: NonNullable<SemgrepResult['dataflow_trace']>,
  ): CodeFlowLocation[] {
    const locations: CodeFlowLocation[] = [];
    const source = this.collectSourceLocation(trace);
    if (source) locations.push(source);
    locations.push(...this.collectIntermediateLocations(trace));
    const sink = this.collectSinkLocation(trace);
    if (sink) locations.push(sink);
    return locations;
  }

  /** 收集 taint_source 位置 */
  private collectSourceLocation(
    trace: NonNullable<SemgrepResult['dataflow_trace']>,
  ): CodeFlowLocation | undefined {
    const source = trace.taint_source?.location;
    return source ? this.toCodeFlowLocation(source, 'taint source') : undefined;
  }

  /** 收集 intermediate_vars 位置 */
  private collectIntermediateLocations(
    trace: NonNullable<SemgrepResult['dataflow_trace']>,
  ): CodeFlowLocation[] {
    const locations: CodeFlowLocation[] = [];
    for (const iv of trace.intermediate_vars ?? []) {
      if (iv?.location) {
        locations.push(
          this.toCodeFlowLocation(
            iv.location,
            iv.var_name ? `intermediate var: ${iv.var_name}` : 'intermediate var',
          ),
        );
      }
    }
    return locations;
  }

  /** 收集 taint_sink 位置 */
  private collectSinkLocation(
    trace: NonNullable<SemgrepResult['dataflow_trace']>,
  ): CodeFlowLocation | undefined {
    const sink = trace.taint_sink?.location;
    return sink ? this.toCodeFlowLocation(sink, 'taint sink') : undefined;
  }

  private toCodeFlowLocation(loc: SemgrepLocation, message: string): CodeFlowLocation {
    return {
      location: {
        file: loc.path ?? '',
        line: loc.start?.line,
        column: loc.start?.col ?? loc.start?.column,
      },
      message,
    };
  }

  /** validation_state / sca_info 映射为分类标签，防止安全核心信息静默丢失 */
  private resolveTaxonomies(r: SemgrepResult): string[] | undefined {
    const tags: string[] = [];

    const validationState = r.extra?.validation_state;
    if (validationState) tags.push(`validation:${validationState}`);

    const sca = r.extra?.sca_info;
    if (sca) {
      if (sca.reachable !== undefined)
        tags.push(sca.reachable ? 'sca:reachable' : 'sca:unreachable');
      if (sca.sca_kind) tags.push(`sca:${sca.sca_kind}`);
    }

    return tags.length > 0 ? tags : undefined;
  }

  private resolveRuleId(r: SemgrepResult): string {
    return r.check_id || r.rule?.id || 'semgrep-unknown';
  }

  private resolveFix(r: SemgrepResult): string | undefined {
    return r.extra?.fix || r.extra?.metadata?.fix || undefined;
  }

  private resolveMessage(r: SemgrepResult, ruleId: string): string {
    return r.extra?.message || r.message || `Semgrep: ${ruleId}`;
  }

  private resolveLocation(r: SemgrepResult): { file: string; line: number; column: number } {
    return {
      file: r.path || '',
      line: r.start?.line || 0,
      column: r.start?.col || r.start?.column || 0,
    };
  }

  private resolveFingerprint(ruleId: string, loc: { file: string; line: number }): string {
    return `semgrep:${ruleId}:${loc.file}:${loc.line}`;
  }

  private normalizeSeverity(sev: string): 'error' | 'warning' | 'info' {
    const lower = sev.toLowerCase();
    return lower === 'error' ? 'error' : lower === 'warning' ? 'warning' : 'info';
  }
}

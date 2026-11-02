/**
 * 安全域的 SOP 求值路径（把断链接回去）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-11-02 实测发现的架构断裂（同一份夹具、同一台机器）：
 *   · CLI `inspect --sop` → `security.scan.semgrep.sql-injection` **检出 1 条**
 *   · 桌面安全中心 `runDomain('security')` → **0 检出**，`status='ok'`、`degraded=undefined`
 *
 * 根因是两条入口走两套求值路径：
 *   · SOP 路径 → `@zh/inspect` 的 SemgrepAdapter：**支持 `config.rules` 内联规则**
 *     （sql-injection / xss / command-injection / csrf 等 7 条规则的唯一载体就是它）
 *   · 安全页路径 → `SecurityEngine` → `@zh/security` 的 SemgrepAdapter：**只认 `--config <目录>`**
 *
 * 更糟的是第二层断裂：`SecurityEngine.buildVulnerabilities` 只消费 `legacyVulns`
 * （trivy/grype 的依赖漏洞）与 `crossReport`，**semgrep 的 issue 根本没有进入
 * `vulnerabilities` 的通道** —— 实测安全适配器检出 1 条路径穿越，域执行器仍返回
 * `vulnerabilities: 0`。于是即使规则被求值，结论也会被丢弃。
 *
 * ## 本文件的职责
 *
 * 让安全域**同时**跑两条通道，并把 SOP 通道的结论并入最终报告：
 *   1. **SOP 规则通道**（`runSopInspect({domains:['security']})`）——
 *      产出代码漏洞（semgrep 内联规则：SQL 注入 / XSS / 命令注入 / CSRF / 路径穿越）
 *      与密钥（gitleaks）。走 `@zh/inspect` 适配器族，与 CLI 完全同源。
 *   2. **启发式通道**（`SecurityEngine`）——
 *      产出恶意代码特征（反弹 Shell / 后门 / 供应链投毒 / 加密勒索）与注入指令检测。
 *      这些是 `@zh/security` 独有的正则与 taint 规则，SOP 通道覆盖不到。
 *
 * 两条通道的结论**按 `ruleId + file + line` 去重**后合并，避免同一处问题报两次。
 *
 * ## 为什么不是「把 SecurityEngine 换掉」
 *
 * `SecurityEngine` 还承担着依赖漏洞交叉验证（trivy ∩ grype）与恶意代码多生产者
 * 冲突裁决（malware-heuristic / semgrep / injection-guard 三路），这些能力在
 * `@zh/security` 内聚，直接替换会丢能力。两条通道并存是风险最低的接法。
 */

import type { RuleEngineReport } from '@zh/kernel';
import type { EventEmitter, GovernanceEvent } from '@zh/shared';

import type { DomainExecutionContext } from './types';

/** 安全域 SOP 通道的结论（并入最终报告前） */
export interface SecuritySopFindings {
  /** 代码漏洞条目（来自 semgrep 等 SOP 规则） */
  vulnerabilities: SecurityVulnerabilityFinding[];
  /** SOP 通道的执行健康度：跳过的规则 / 降级数 */
  skipped: number;
  degraded: number;
  /** SOP 通道本身是否产出了结论（false = 规则集为空或通道异常） */
  ran: boolean;
  /** 通道异常原因 */
  reason?: string;
}

/** SOP 通道产出的漏洞条目（与 `@zh/security` 的 Vulnerability 对齐，但用 SOP 的原始字段） */
export interface SecurityVulnerabilityFinding {
  ruleId: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  column?: number;
  message: string;
  suggestion?: string;
}

/** SOP 严重级 → 安全域严重级（SOP 五档 → 安全四档） */
function mapSeverity(severity: string): SecurityVulnerabilityFinding['severity'] {
  switch (severity) {
    case 'critical':
    case 'error':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
    case 'warning':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * 把 SOP 通道的违规条目转成安全域漏洞条目。
 *
 * 只取 `category === 'security'` 的条目 —— SOP 规则可能声明别的类别
 * （如 quality），那些不归安全域（O2/O3/O9 的域归属纪律）。
 */
export function sopViolationsToFindings(report: RuleEngineReport): SecurityVulnerabilityFinding[] {
  const findings: SecurityVulnerabilityFinding[] = [];
  for (const evaluation of report.evaluations) {
    if (evaluation.status !== 'failed') continue;
    for (const violation of evaluation.violations ?? []) {
      const category = violation.category;
      if (category && category !== 'security') continue;
      findings.push({
        ruleId: violation.ruleId,
        severity: mapSeverity(violation.severity),
        file: violation.file,
        ...(violation.line !== undefined ? { line: violation.line } : {}),
        ...(violation.column !== undefined ? { column: violation.column } : {}),
        message: violation.message,
        ...(violation.suggestion ? { suggestion: violation.suggestion } : {}),
      });
    }
  }
  return findings;
}

/** 两条通道的指纹（同一处问题只报一次） */
function fingerprintOf(f: { ruleId: string; file: string; line?: number }): string {
  return `${f.ruleId}:${f.file}:${f.line ?? 0}`;
}

/**
 * 跑安全域的 SOP 规则通道。
 *
 * 需要 `ctx.runner`（PipelineRunnerLike）—— 没有它就没有规则集，SOP 通道无法执行，
 * 此时如实返回 `ran: false` 并说明原因，**不得**静默返回 0 条结论。
 */
export async function runSecuritySopChannel(
  ctx: DomainExecutionContext,
): Promise<SecuritySopFindings> {
  if (!ctx.runner) {
    return {
      vulnerabilities: [],
      skipped: 0,
      degraded: 0,
      ran: false,
      reason: '未提供 PipelineRunner，安全域 SOP 规则通道未执行（仅启发式通道）',
    };
  }

  try {
    ctx.onEvent?.({ domain: 'security', kind: 'rule-channel-started' });
    const report = (await ctx.runner.runSopInspect({
      domains: ['security'],
    })) as RuleEngineReport;

    if (report.total === 0) {
      return {
        vulnerabilities: [],
        skipped: report.skipped,
        degraded: report.degraded ?? 0,
        ran: false,
        reason: '无规则可评估（规则集为空），SOP 规则通道本次未执行',
      };
    }

    return {
      vulnerabilities: sopViolationsToFindings(report),
      skipped: report.skipped,
      degraded: report.degraded ?? 0,
      ran: true,
    };
  } catch (err) {
    return {
      vulnerabilities: [],
      skipped: 0,
      degraded: 0,
      ran: false,
      reason: `安全域 SOP 规则通道异常：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 合并两条通道的漏洞结论（按指纹去重）。
 *
 * 启发式通道的结论已在 `SecurityScanReport.vulnerabilities` 里；
 * SOP 通道的结论以 `SecurityVulnerabilityFinding` 形态进来。
 * 两条通道的 `ruleId` 命名空间不同（`semgrep.*` vs SOP 规则 id），不会误合并。
 */
export function mergeVulnerabilityFindings(
  existing: readonly { ruleId: string; file: string; line?: number }[],
  incoming: readonly SecurityVulnerabilityFinding[],
): SecurityVulnerabilityFinding[] {
  const seen = new Set(existing.map(fingerprintOf));
  const merged: SecurityVulnerabilityFinding[] = [];
  for (const finding of incoming) {
    const key = fingerprintOf(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(finding);
  }
  return merged;
}

/**
 * 事件转发器：把引擎事件接到域事件通道（进度条据此显示当前工具）。
 *
 * 返回 `EventEmitter`（@zh/shared 的结构契约）而不是裸函数 —— `SecurityEngine`
 * 的构造参数要求的就是这个形状。返回 undefined 时 `SecurityEngine` 用默认空发射器。
 */
export function createSecurityEventForwarder(
  onEvent: DomainExecutionContext['onEvent'],
): EventEmitter | undefined {
  if (!onEvent) return undefined;
  return {
    emit(event: GovernanceEvent): void {
      onEvent({
        domain: 'security',
        kind: event.type,
        payload: event.payload as unknown as Record<string, unknown>,
      });
    },
  };
}

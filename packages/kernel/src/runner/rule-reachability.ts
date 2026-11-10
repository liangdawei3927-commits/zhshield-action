/**
 * R7 §3.5：规则集静态可达性检查——**不跑扫描**就回答「这条规则有没有可能被评估」。
 *
 * ## 为什么需要它
 *
 * 降级只在**运行时**才暴露（跑完才知道某条规则没跑成）。换一台没装工具的环境，
 * 降级清单就变一次；维护者只能等用户截图里出现「N 条规则未能评估」再去查。
 * 2026-11-11 实机：`inspect.scan.external.dependency-audit` 在体检域**每轮必降级**，
 * 原因写着「npm-audit / trivy / grype 未注册工具适配器」——这不是环境问题，
 * 是规则集里的事实死代码，却要跑完一轮才看得见。
 *
 * 本模块把这条判据前移到静态：
 *   · 规则归属其它域 → **让位**，不算缺口（C3：非 Owner 不重扫）
 *   · 规则声明了工具，但工具**不在能力表** `TOOL_CAPABILITIES` → 违反（不可调度）
 *   · 规则本身不是 active（draft/trial）→ 只记 warning，不判失败
 *
 * ## 纪律
 *
 * 判据只认「能力表登记」这一条硬事实，不猜适配器实现——后者是运行时注册的，
 * 静态猜会造出「看起来检查了、其实没效力」的假门禁（07 §7.7：无效测量判 INVALID）。
 * 加载不到任何规则时返回 `invalid`，由调用方判 INVALID，绝不判 PASS。
 */

import { resolveOwnerId, TOOL_CAPABILITIES } from '@zh/shared';

import type { SopRule } from '../sop/_meta/sop-types';

/** 单条规则的不可达问题 */
export interface RuleReachabilityViolation {
  /** 规则 id */
  ruleId: string;
  /** 规则所属域 */
  domain: string;
  /** 规则声明要调用的工具 */
  tool: string;
  /** 违反类型：工具未登记 / 归属冲突 */
  kind: 'unregistered-tool' | 'ownership-conflict';
  /** 修复建议（给人看的，不是机器判据） */
  hint: string;
}

/** 非失败但需要记录的条目（如 draft/trial 规则声明了未登记工具） */
export interface RuleReachabilityWarning {
  ruleId: string;
  domain: string;
  tool: string;
  reason: string;
}

/** 检查结果（三态：通过 / 失败 / 无效） */
export interface RuleReachabilityResult {
  /** 参与检查的 tool-dispatch 规则数 */
  checked: number;
  /** 因归属其它域而让位、不参与判定的规则数 */
  delegated: number;
  /** 失败项 */
  violations: RuleReachabilityViolation[];
  /** 非失败项 */
  warnings: RuleReachabilityWarning[];
  /** 是否通过了检查（无违反项，且确实检查到了规则） */
  ok: boolean;
  /** ok=false 且无 violations 时的原因（如「规则集为空」→ INVALID） */
  invalidReason?: string;
}

/** 规则声明的工具：`check.tool`（单工具）与 `check.scanners`（多扫描器） */
function declaredTools(rule: SopRule): string[] {
  const check = rule.content?.check;
  if (!check || typeof check !== 'object') return [];
  const record = check as Record<string, unknown>;
  const tools: string[] = [];
  if (typeof record.tool === 'string' && record.tool.length > 0) tools.push(record.tool);
  if (Array.isArray(record.scanners)) {
    for (const scanner of record.scanners) {
      if (typeof scanner === 'string' && scanner.length > 0) tools.push(scanner);
    }
  }
  return [...new Set(tools)];
}

/**
 * 检查一批规则的静态可达性。
 *
 * @param rules 已加载的 SOP 规则（通常来自内置模板 / 云端规则）
 */
export function checkRuleReachability(rules: readonly SopRule[]): RuleReachabilityResult {
  let checked = 0;
  let delegated = 0;
  const violations: RuleReachabilityViolation[] = [];
  const warnings: RuleReachabilityWarning[] = [];

  for (const rule of rules) {
    const tools = declaredTools(rule);
    if (tools.length === 0) continue;
    checked += 1;

    const owner = resolveOwnerId(rule.id);
    if (owner && owner !== rule.domain) {
      // 归属让位：本域不执行、不算缺口（与 dispatch-tool-scan 的让位分支同口径）
      delegated += 1;
      continue;
    }

    for (const tool of tools) {
      if (rule.status !== 'active') {
        // draft/trial 尚未投产：现在不可达是预期内的，但不能让它悄悄 active 化
        warnings.push({
          ruleId: rule.id,
          domain: rule.domain,
          tool,
          reason: `规则状态为 ${rule.status}，工具 ${tool} 不在能力表；投产前必须登记或改归属`,
        });
        continue;
      }
      if (!TOOL_CAPABILITIES.some((capability) => capability.tool === tool)) {
        violations.push({
          ruleId: rule.id,
          domain: rule.domain,
          tool,
          kind: 'unregistered-tool',
          hint: `在 TOOL_CAPABILITIES 登记 ${tool}，或把规则归属给实际负责的域（C3）`,
        });
      }
    }
  }

  if (checked === 0) {
    return {
      checked: 0,
      delegated: 0,
      violations: [],
      warnings: [],
      ok: false,
      invalidReason: '未加载到任何 tool-dispatch 规则 —— 本次测量无输入，判 INVALID 而不是通过',
    };
  }

  return { checked, delegated, violations, warnings, ok: violations.length === 0 };
}

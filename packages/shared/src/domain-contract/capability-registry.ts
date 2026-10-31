/**
 * 工具能力注册表（《07》§7.3 / §7.5）。
 *
 * 共享的是 **bin**，不是 **结论**：同一把 semgrep 只起一个进程，但按规则族切片，
 * 产出的 issue 按 `ruleId → owner` 路由给对应域（C1/C2）。
 *
 * 域级预算与熔断（§7.5）：`hardTimeoutMs < budgetMs`。超时 → 该工具的结果进
 * `skipped[]`，不拖垮全局；域超预算 → 该域 `unavailable`，其余域继续。
 *
 * 注：规范示例里的 `osv` / `bundle analyzer` 在本仓库尚未以独立 ToolId 注册
 * （唯一来源 `TOOL_IDS`），故这里用已注册的等价工具（`npm-audit` / `trivy`），
 * 不新增 ToolId —— 避免规则校验「声明的 tool 是否真实存在」失效（曾导致规则静默空跑）。
 */
import type { ToolId } from '../types';
import { resolveOwnerId } from './ownership-registry';
import type { DomainId } from './types';

/** 工具目标类型（FileIndex 产出的分类） */
export type ToolTargetKind = 'source' | 'manifest' | 'lockfile' | 'build-output';

/** 运行前提：联网 / 依赖数据库（不可达时按 C4 记 skipped） */
export type ToolRunRequirement = 'none' | 'network' | 'db';

/** 规则族 → 唯一 Owner */
export interface RuleFamily {
  ruleId: string;
  owner: DomainId;
}

/** 单工具能力声明 */
export interface ToolCapability {
  tool: ToolId;
  /** 该工具产出哪些规则族；每个 ruleId 的 owner 必须与 ownership-registry 一致 */
  ruleFamilies: readonly RuleFamily[];
  targets: readonly ToolTargetKind[];
  /** 域级预算 */
  budgetMs: number;
  /** 硬超时，必须 < budgetMs */
  hardTimeoutMs: number;
  requires: ToolRunRequirement;
}

/**
 * 静态扫描域的预算（§7.5）。哨兵/备份按运行时常量运行，不参与静态扫描预算，
 * 故此处刻意不列（`Partial` 而非 `Record`），避免给它们编造静态预算。
 */
export const SCAN_DOMAIN_BUDGETS = {
  inspect: 90_000,
  guard: 10_000,
  security: 120_000,
  deps: 90_000,
  garbage: 45_000,
  performance: 60_000,
  refactor: 60_000,
  techdebt: 10_000,
} as const satisfies Partial<Record<DomainId, number>>;

/** 工具能力表（规范 §7.3 分工表的可执行形态） */
export const TOOL_CAPABILITIES: readonly ToolCapability[] = [
  {
    tool: 'semgrep',
    ruleFamilies: [
      { ruleId: 'security.scan.official.injection', owner: 'security' },
      { ruleId: 'security.scan.official.xss', owner: 'security' },
      { ruleId: 'security.scan.official.ssrf', owner: 'security' },
    ],
    targets: ['source'],
    budgetMs: 120_000,
    hardTimeoutMs: 110_000,
    requires: 'none',
  },
  {
    tool: 'gitleaks',
    ruleFamilies: [{ ruleId: 'security.scan.official.secrets', owner: 'security' }],
    targets: ['source'],
    budgetMs: 120_000,
    hardTimeoutMs: 110_000,
    requires: 'none',
  },
  {
    tool: 'trivy',
    ruleFamilies: [{ ruleId: 'deps.scan.official.cve', owner: 'deps' }],
    targets: ['manifest', 'lockfile'],
    budgetMs: 90_000,
    // 实测曾出现 trivy 单次 300s 拖垮全局，硬超时远小于域预算
    hardTimeoutMs: 60_000,
    requires: 'db',
  },
  {
    tool: 'npm-audit',
    ruleFamilies: [{ ruleId: 'deps.scan.official.cve.npm', owner: 'deps' }],
    targets: ['manifest', 'lockfile'],
    budgetMs: 90_000,
    hardTimeoutMs: 60_000,
    requires: 'network',
  },
  {
    tool: 'eslint',
    ruleFamilies: [
      { ruleId: 'inspect.scan.official.style', owner: 'inspect' },
      { ruleId: 'inspect.scan.official.naming', owner: 'inspect' },
    ],
    targets: ['source'],
    budgetMs: 90_000,
    hardTimeoutMs: 80_000,
    requires: 'none',
  },
  {
    tool: 'tsc',
    ruleFamilies: [{ ruleId: 'inspect.scan.official.type-safety', owner: 'inspect' }],
    targets: ['source', 'manifest'],
    budgetMs: 90_000,
    hardTimeoutMs: 80_000,
    requires: 'none',
  },
  {
    tool: 'dep-cruiser',
    ruleFamilies: [
      { ruleId: 'inspect.scan.official.circular-dependency', owner: 'inspect' },
      { ruleId: 'inspect.scan.official.module-boundary', owner: 'inspect' },
    ],
    targets: ['source'],
    budgetMs: 90_000,
    hardTimeoutMs: 80_000,
    requires: 'none',
  },
  {
    tool: 'jscpd',
    ruleFamilies: [{ ruleId: 'refactor.scan.official.duplication', owner: 'refactor' }],
    targets: ['source'],
    budgetMs: 60_000,
    hardTimeoutMs: 50_000,
    requires: 'none',
  },
  {
    tool: 'ts-prune',
    ruleFamilies: [{ ruleId: 'garbage.scan.official.dead-code', owner: 'garbage' }],
    targets: ['source', 'manifest'],
    budgetMs: 45_000,
    hardTimeoutMs: 35_000,
    requires: 'none',
  },
  {
    tool: 'depcheck',
    ruleFamilies: [{ ruleId: 'garbage.scan.official.unused-dependency', owner: 'garbage' }],
    targets: ['source', 'manifest'],
    budgetMs: 45_000,
    hardTimeoutMs: 35_000,
    requires: 'none',
  },
];

/** 能力表违约类型（A11 校验输出） */
export type CapabilityViolationKind =
  | 'duplicate-tool'
  | 'duplicate-rule'
  | 'owner-mismatch'
  | 'budget-inconsistent'
  | 'no-targets'
  | 'invalid-owner';

/** A11 校验结果条目 */
export interface CapabilityViolation {
  kind: CapabilityViolationKind;
  tool?: ToolId;
  ruleId?: string;
  message: string;
}

/**
 * A11 校验：ruleId 0 重复、均有 owner、owner 与 ownership-registry 一致、
 * `hardTimeoutMs < budgetMs`、targets 非空。
 */
export function validateCapabilityRegistry(): CapabilityViolation[] {
  const violations: CapabilityViolation[] = [];
  const tools = new Set<ToolId>();
  const rules = new Map<string, DomainId>();

  for (const cap of TOOL_CAPABILITIES) {
    if (tools.has(cap.tool)) {
      violations.push({ kind: 'duplicate-tool', tool: cap.tool, message: `工具 ${cap.tool} 重复注册` });
    }
    tools.add(cap.tool);

    if (cap.targets.length === 0) {
      violations.push({ kind: 'no-targets', tool: cap.tool, message: `工具 ${cap.tool} 未声明目标类型` });
    }

    if (cap.hardTimeoutMs >= cap.budgetMs) {
      violations.push({
        kind: 'budget-inconsistent',
        tool: cap.tool,
        message: `hardTimeoutMs(${cap.hardTimeoutMs}) 必须 < budgetMs(${cap.budgetMs})`,
      });
    }

    for (const family of cap.ruleFamilies) {
      const existing = rules.get(family.ruleId);
      if (existing !== undefined) {
        violations.push({
          kind: 'duplicate-rule',
          tool: cap.tool,
          ruleId: family.ruleId,
          message: `规则族 ${family.ruleId} 已归属 ${existing}，又被 ${family.owner} 重复声明`,
        });
        continue;
      }
      rules.set(family.ruleId, family.owner);

      const resolved = resolveOwnerId(family.ruleId);
      if (resolved !== family.owner) {
        violations.push({
          kind: 'owner-mismatch',
          tool: cap.tool,
          ruleId: family.ruleId,
          message: `规则族 ${family.ruleId} 声明 owner=${family.owner}，但归属表解析为 ${resolved ?? 'null'}`,
        });
      }
    }
  }

  return violations;
}

/** 取某工具的能力声明；未注册返回 null（调用方应记 skipped 而不是静默跳过） */
export function findToolCapability(tool: ToolId): ToolCapability | null {
  return TOOL_CAPABILITIES.find((c) => c.tool === tool) ?? null;
}

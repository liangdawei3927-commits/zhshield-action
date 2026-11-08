/**
 * 规则归属注册表（C1「单源原则」的机器可校验载体）。
 *
 * 每个检测项（ruleId）有且只有一个 Owner 域。裁决来源是《07》§四 重叠裁决表 O1–O10：
 *   O1 重复代码 → refactor      （体检降级为「重复率指标」，不列明细）
 *   O2/O10 依赖包 CVE → deps    （安全中心不再注册依赖漏洞源）
 *   O3 密钥 → security          （门禁/体检只读安全结论）
 *   O4 嵌套循环 → performance；圈复杂度 → inspect（两个指标指纹不同）
 *   O7 未使用依赖 → garbage     （依赖管家不得报 unused）
 *   O9 代码漏洞 → security      （体检不再跑 semgrep 出 issue）
 *
 * 匹配优先级：exact（整条 ruleId）> token（ruleId 中的某一段）> prefix（域前缀）。
 * 这样 `inspect.scan.official.duplication` 既能被 inspect 前缀命中，也能被
 * duplication 这个 token 精确改判给 refactor —— 重叠项就是靠「token 压过 prefix」落地。
 *
 * 注：规范 §八 A1 写的是 `ownership-registry.json`；这里用 TS 常量而不是 JSON，
 * 因为 JSON 无法约束 DomainId 类型、也无法在仓库内被 vitest 直接断言，容易与代码漂移。
 * `validateOwnershipRegistry()` 即为 A1 的校验脚本实现。
 */
import { DOMAIN_IDS, type DomainId } from './types';

/** 匹配方式：精确 ruleId / ruleId 中的一段 / 域前缀 */
export type OwnershipMatch =
  | { kind: 'exact'; ruleId: string }
  | { kind: 'token'; token: string }
  | { kind: 'prefix'; prefix: string };

/** 一条归属声明 */
export interface OwnershipClaim {
  match: OwnershipMatch;
  /** 裁决后的唯一 Owner（C1） */
  owner: DomainId;
  /** 裁决依据：规范 §四 的重叠编号（O1…O10）或契约条款 */
  rationale: string;
  /** 历史上曾产出该问题的域（用于说明「已降级为只读」） */
  previousOwner?: DomainId;
}

/** 归属声明表。允许出现同 key 的重复声明 —— 那正是 `validateOwnershipRegistry()` 要抓的错 */
export const OWNERSHIP_CLAIMS: readonly OwnershipClaim[] = [
  // ── 域前缀兜底：`<domain>.scan...` 天然归该域 ─────────────────────────
  ...DOMAIN_IDS.map((domain): OwnershipClaim => ({
    match: { kind: 'prefix', prefix: domain },
    owner: domain,
    rationale: 'C1 域前缀默认归属',
  })),

  // ── O1 重复代码：唯一归重构 ────────────────────────────────────────────
  {
    match: { kind: 'exact', ruleId: 'inspect.scan.official.duplication' },
    owner: 'refactor',
    rationale: 'O1 重复代码唯一归重构；体检只读重复率指标',
    previousOwner: 'inspect',
  },
  {
    match: { kind: 'token', token: 'duplication' },
    owner: 'refactor',
    rationale: 'O1 重复代码唯一归重构',
  },
  {
    match: { kind: 'token', token: 'duplicated-code' },
    owner: 'refactor',
    rationale: 'O1 重复代码唯一归重构',
  },
  {
    match: { kind: 'token', token: 'jscpd' },
    owner: 'refactor',
    rationale: 'O1 jscpd 产出重复明细，归重构',
  },

  // ── O2 / O10 依赖包 CVE：唯一归依赖管家 ────────────────────────────────
  {
    match: { kind: 'token', token: 'cve' },
    owner: 'deps',
    rationale: 'O2 依赖包 CVE 唯一归依赖管家',
  },
  {
    match: { kind: 'exact', ruleId: 'inspect.scan.official.dependency-audit' },
    owner: 'deps',
    rationale: 'O10 依赖审计唯一归依赖管家；体检改只读',
    previousOwner: 'inspect',
  },
  {
    match: { kind: 'token', token: 'trivy' },
    owner: 'deps',
    rationale: 'O2 trivy 的依赖扫描归依赖管家',
  },
  {
    match: { kind: 'token', token: 'grype' },
    owner: 'deps',
    rationale: 'O2 grype 的依赖扫描归依赖管家',
  },
  { match: { kind: 'token', token: 'osv' }, owner: 'deps', rationale: 'O2 OSV 归依赖管家' },

  // ── O3 密钥：唯一归安全中心 ────────────────────────────────────────────
  {
    match: { kind: 'token', token: 'secrets' },
    owner: 'security',
    rationale: 'O3 密钥唯一归安全中心',
  },
  {
    match: { kind: 'token', token: 'secret' },
    owner: 'security',
    rationale: 'O3 密钥唯一归安全中心',
  },
  {
    match: { kind: 'token', token: 'sensitive-info' },
    owner: 'security',
    rationale: 'O3 敏感信息唯一归安全中心',
  },
  {
    match: { kind: 'token', token: 'gitleaks' },
    owner: 'security',
    rationale: 'O3 gitleaks 产出归安全中心',
  },

  // ── O9 代码漏洞：唯一归安全中心 ────────────────────────────────────────
  {
    match: { kind: 'token', token: 'semgrep' },
    owner: 'security',
    rationale: 'O9 代码漏洞唯一归安全中心',
  },
  {
    match: { kind: 'exact', ruleId: 'inspect.scan.official.code-vulnerability' },
    owner: 'security',
    rationale: 'O9 代码漏洞唯一归安全中心；体检改只读',
    previousOwner: 'inspect',
  },
  {
    match: { kind: 'token', token: 'injection' },
    owner: 'security',
    rationale: 'O9 注入类问题归安全中心',
  },
  { match: { kind: 'token', token: 'xss' }, owner: 'security', rationale: 'O9 XSS 归安全中心' },
  { match: { kind: 'token', token: 'ssrf' }, owner: 'security', rationale: 'O9 SSRF 归安全中心' },
  {
    match: { kind: 'token', token: 'malware' },
    owner: 'security',
    rationale: '安全中心独占恶意代码检测',
  },
  { match: { kind: 'token', token: 'taint' }, owner: 'security', rationale: '安全中心独占污点链' },

  // ── O4 嵌套循环 / 圈复杂度：指纹不同，分属两域 ─────────────────────────
  {
    match: { kind: 'token', token: 'nested-loop' },
    owner: 'performance',
    rationale: 'O4 运行时反模式归性能域',
  },
  {
    match: { kind: 'token', token: 'sync-io' },
    owner: 'performance',
    rationale: 'O4 运行时反模式归性能域',
  },
  {
    match: { kind: 'token', token: 'complexity' },
    owner: 'inspect',
    rationale: 'O4 函数级圈复杂度归体检',
  },

  // ── O7 未使用依赖：唯一归垃圾清理 ─────────────────────────────────────
  {
    match: { kind: 'token', token: 'unused-dependency' },
    owner: 'garbage',
    rationale: 'O7 未使用依赖唯一归垃圾清理',
  },
  {
    match: { kind: 'token', token: 'unused-deps' },
    owner: 'garbage',
    rationale: 'O7 未使用依赖唯一归垃圾清理',
  },
  {
    match: { kind: 'token', token: 'depcheck' },
    owner: 'garbage',
    rationale: 'O7 depcheck 产出归垃圾清理',
  },

  // ── 其余工具族归属 ────────────────────────────────────────────────────
  {
    match: { kind: 'token', token: 'dead-code' },
    owner: 'garbage',
    rationale: '垃圾清理独占死代码',
  },
  {
    match: { kind: 'token', token: 'ts-prune' },
    owner: 'garbage',
    rationale: '垃圾清理独占死代码',
  },
  {
    match: { kind: 'token', token: 'eslint' },
    owner: 'inspect',
    rationale: '体检独占规范/风格检查',
  },
  {
    match: { kind: 'token', token: 'type-safety' },
    owner: 'inspect',
    rationale: '体检独占类型安全',
  },
  {
    match: { kind: 'token', token: 'circular-dependency' },
    owner: 'inspect',
    rationale: '体检独占循环依赖',
  },
  {
    match: { kind: 'token', token: 'module-boundary' },
    owner: 'inspect',
    rationale: '体检独占模块边界',
  },
  {
    match: { kind: 'token', token: 'dep-cruiser' },
    owner: 'inspect',
    rationale: '体检独占架构依赖规则',
  },
];

/** 冲突类型（A1 校验输出） */
export type OwnershipConflictKind =
  'duplicate-exact' | 'duplicate-token' | 'duplicate-prefix' | 'invalid-owner';

/** A1 校验结果条目 */
export interface OwnershipConflict {
  kind: OwnershipConflictKind;
  /** 冲突的 key（ruleId / token / prefix） */
  key: string;
  /** 冲突双方声明的 owner，便于定位 */
  owners: DomainId[];
  message: string;
}

/** token 切分：`inspect.scan.official.duplication`、`eslint:no-var` 都要能切出家族名 */
/** ruleId 的家族切分符（`inspect.scan.x` 与 `eslint:no-var` 两种写法）：模块级复用避免重编译 */
const RULE_ID_SEPARATOR_RE = /[.:]/;

function segmentsOf(ruleId: string): string[] {
  return ruleId.split(RULE_ID_SEPARATOR_RE).filter((s) => s.length > 0);
}

/**
 * 解析某 ruleId 的唯一 Owner（C1）。
 *
 * 优先级：exact > token（越靠右越精确）> prefix（最长前缀优先）。
 * 返回整条 claim 而不是仅 DomainId，便于 Router 记录裁决依据。
 */
export function resolveOwnerClaim(ruleId: string): OwnershipClaim | null {
  const exact = OWNERSHIP_CLAIMS.find((c) => c.match.kind === 'exact' && c.match.ruleId === ruleId);
  if (exact) return exact;

  const segments = segmentsOf(ruleId);

  let bestToken: { claim: OwnershipClaim; index: number } | null = null;
  for (const claim of OWNERSHIP_CLAIMS) {
    if (claim.match.kind !== 'token') continue;
    const index = segments.lastIndexOf(claim.match.token);
    if (index < 0) continue;
    if (bestToken === null || index > bestToken.index) bestToken = { claim, index };
  }
  if (bestToken) return bestToken.claim;

  let bestPrefix: { claim: OwnershipClaim; length: number } | null = null;
  for (const claim of OWNERSHIP_CLAIMS) {
    if (claim.match.kind !== 'prefix') continue;
    if (!ruleId.startsWith(`${claim.match.prefix}.`)) continue;
    const length = claim.match.prefix.length;
    if (bestPrefix === null || length > bestPrefix.length) bestPrefix = { claim, length };
  }
  return bestPrefix?.claim ?? null;
}

/** 解析某 ruleId 的唯一 Owner 域；无归属返回 null（Router 会视为 unrouted 并上报） */
export function resolveOwnerId(ruleId: string): DomainId | null {
  return resolveOwnerClaim(ruleId)?.owner ?? null;
}

/** 稳定 key：A1 要求同一 ruleId/token/prefix 不得出现两条声明 */
function matchKey(match: OwnershipMatch): string {
  switch (match.kind) {
    case 'exact':
      return `exact:${match.ruleId}`;
    case 'token':
      return `token:${match.token}`;
    case 'prefix':
      return `prefix:${match.prefix}`;
  }
}

/**
 * A1 校验：归属声明表内 0 个重复 key、0 个非法 owner。
 * 有返回值即违约，应当阻塞发布（由单测断言为空）。
 */
export function validateOwnershipRegistry(): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];
  const seen = new Map<string, OwnershipClaim[]>();

  for (const claim of OWNERSHIP_CLAIMS) {
    const key = matchKey(claim.match);
    const list = seen.get(key);
    if (list) list.push(claim);
    else seen.set(key, [claim]);

    if (!(DOMAIN_IDS as readonly string[]).includes(claim.owner)) {
      conflicts.push({
        kind: 'invalid-owner',
        key,
        owners: [claim.owner],
        message: `owner "${claim.owner}" 不在 DomainId 白名单内`,
      });
    }
  }

  for (const [key, claims] of seen) {
    if (claims.length < 2) continue;
    const kind = key.slice(0, key.indexOf(':')) as OwnershipConflictKind;
    conflicts.push({
      kind,
      key,
      owners: claims.map((c) => c.owner),
      message: `${key} 被 ${claims.length} 条声明重复占用（C1 违反）`,
    });
  }

  return conflicts;
}

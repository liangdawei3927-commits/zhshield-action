/**
 * 硬编码密钥检测模式 — 门禁 ↔ 安全中心同源（T8 口径统一）
 *
 * 门禁（L1 pre-commit）必须**零外部二进制可跑**，装工具只是可选项，因此走纯正则；
 * 安全中心走 gitleaks 全量规则集（222 条）+ 工作区/git 历史/CI env 扩展范围。
 * 两者无法逐条相等——这是设计意图，不是偏差。
 *
 * 能统一的、也必须统一的是**规则命名空间**：本表每一行都用 `gitleaksId` 锚定到
 * gitleaks 的规则 id，并且必须是 `guard/block/sensitive-info.yml` 的
 * `standards.gitleaks`（门禁自己声明要拦的类目）的**覆盖**——
 * 门禁不允许声明了却不实现。该约束由
 * `kernel/src/__tests__/secret-patterns-parity.test.ts` 锁定。
 *
 * 安全中心的范围是门禁的**超集**（工作区全量 + git 历史 + CI env），方向上有意为之：
 * 提交时只拦暂存区里的高置信类目，全面治理阶段再扫历史遗留。
 */
export interface SecretPattern {
  /** gitleaks 规则 id —— 与安全中心同源的锚点 */
  gitleaksId: string;
  /** 展示名（进报告 message） */
  name: string;
  regex: RegExp;
}

/**
 * 顺序即匹配优先级：一行命中多个模式时取第一个匹配的名字。
 * 精确类目（AWS/GitHub/Stripe/私钥/JWT/连接串）排在启发式类目（generic）之前，
 * 避免通用正则抢占精确命名的报告口径。
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { gitleaksId: 'aws-access-token', name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { gitleaksId: 'github-pat', name: 'GitHub Token', regex: /gh[psu]_[a-zA-Z0-9]{36,}/ },
  { gitleaksId: 'stripe-api-key', name: 'Stripe Secret Key', regex: /sk_live_[0-9a-zA-Z]{24,}/ },
  {
    gitleaksId: 'private-ssh-key',
    name: 'Private Key',
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/,
  },
  {
    gitleaksId: 'jwt-token',
    name: 'JWT Token',
    regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/,
  },
  {
    gitleaksId: 'database-connection-string',
    name: 'Database Connection String',
    regex: /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s:@/]+@/,
  },
  {
    gitleaksId: 'generic-api-key',
    name: 'OpenAI API Key',
    regex: /sk-[a-zA-Z0-9]{32,}/,
  },
  {
    gitleaksId: 'generic-api-key',
    name: 'API Key/Password/Secret',
    regex: /(?:api[_-]?key|password|secret|token|credential)\s*[:=]\s*['"][^'"]+['"]/i,
  },
];

/** 门禁适配器消费的 {name, regex} 视图（与历史构造签名兼容） */
export function toNameRegexPatterns(
  patterns: readonly SecretPattern[] = SECRET_PATTERNS,
): { name: string; regex: RegExp }[] {
  return patterns.map(({ name, regex }) => ({ name, regex }));
}

/**
 * 安全配置类 check 的判定（安全头 / 会话 / 审计日志 / 密钥轮换 / 供应链签名）。
 *
 * 与 security-config-scan 的分工：扫描器只出证据位置，本模块才下结论。
 * 判定遵守两条纪律：
 *   1. 不适用要显式标注（applicability），不得用 passed 冒充「已验证」；
 *   2. 未检出机制按 failed 记（确实是个缺口），但文案必须写明检测范围
 *      （源码/CI 配置模式），避免被读成运行期已验证。
 */
import type { SecurityCheckResult } from './security-check-result';
import type { SourceEvidence, SourceHit } from './security-config-scan';

/** 判定所需项目形态：由依赖清单与源码证据派生，不由本模块自己扫描 */
export interface ConfigContext {
  hasWebFramework: boolean;
  hasHelmet: boolean;
  hasAuthLib: boolean;
  hasJwtLib: boolean;
  hasLoggerLib: boolean;
  hasKeyLib: boolean;
  hasDependencies: boolean;
  hasSignatureScript: boolean;
  hasCryptoUsage: boolean;
}

/** 通用命中判定：0 命中 → passed，否则 failed，最多列 3 条样例 */
export function makeVerdict<T>(
  check: string,
  hits: T[],
  describe: (item: T) => string,
): SecurityCheckResult {
  if (hits.length === 0) {
    return { status: 'passed', message: `${check}: 未发现风险` };
  }
  const samples = hits.slice(0, 3).map(describe).join('; ');
  return { status: 'failed', message: `${check}: 检测到 ${hits.length} 处风险（${samples}）` };
}

function notApplicable(check: string, reason: string): SecurityCheckResult {
  return { status: 'passed', applicability: 'not-applicable', message: `${check}: ${reason}` };
}

function passed(check: string, detail: string): SecurityCheckResult {
  return { status: 'passed', message: `${check}: ${detail}` };
}

function failed(check: string, detail: string): SecurityCheckResult {
  return { status: 'failed', message: `${check}: ${detail}` };
}

/** 首条命中的位置（文案里必须能定位到文件行） */
function firstHit(hits: SourceHit[]): string {
  const first = hits[0];
  return first ? `${first.file}:${first.line}` : '';
}

interface HeaderSpec {
  label: string;
  disabled: SourceHit[];
  configured: SourceHit[];
}

/** 安全响应头判定：显式配置 > helmet 默认策略 > 未检出（fail） */
function headerVerdict(
  check: string,
  ctx: ConfigContext,
  helmetCalls: SourceHit[],
  spec: HeaderSpec,
): SecurityCheckResult {
  if (!ctx.hasWebFramework) {
    return notApplicable(check, '项目未使用 Web 框架，安全响应头没有装配位置');
  }
  if (spec.disabled.length > 0) {
    return failed(check, `检测到显式关闭 ${spec.label}（${firstHit(spec.disabled)}）`);
  }
  if (spec.configured.length > 0) {
    return passed(check, `检出 ${spec.label} 配置（${firstHit(spec.configured)}）`);
  }
  return helmetFallback(check, ctx, helmetCalls, spec.label);
}

/** helmet() 默认策略包含 CSP / HSTS / X-Frame-Options；仅凭依赖安装不算生效 */
function helmetFallback(
  check: string,
  ctx: ConfigContext,
  helmetCalls: SourceHit[],
  label: string,
): SecurityCheckResult {
  if (ctx.hasHelmet && helmetCalls.length > 0) {
    return passed(check, `helmet 默认策略已启用 ${label}（${firstHit(helmetCalls)}）`);
  }
  if (ctx.hasHelmet) {
    return failed(check, `检测到 helmet 依赖但未检出装配调用，默认 ${label} 策略未生效`);
  }
  return failed(check, `未检出 ${label} 配置，也未检出 helmet 默认启用`);
}

function hstsVerdict(check: string, ctx: ConfigContext, source: SourceEvidence): SecurityCheckResult {
  if (!ctx.hasWebFramework) {
    return notApplicable(check, '项目未使用 Web 框架，HSTS 没有装配位置');
  }
  if (source.hstsDisabled.length > 0) {
    return failed(check, `检测到显式关闭 HSTS（${firstHit(source.hstsDisabled)}）`);
  }
  if (source.hstsWeak.length > 0) {
    return failed(check, `HSTS maxAge 低于 180 天（${firstHit(source.hstsWeak)}）`);
  }
  if (source.hstsConfigured.length > 0) {
    return passed(check, `检出 HSTS 配置（${firstHit(source.hstsConfigured)}）`);
  }
  return helmetFallback(check, ctx, source.helmetCall, 'HSTS');
}

function sessionCookieVerdict(
  check: string,
  ctx: ConfigContext,
  source: SourceEvidence,
): SecurityCheckResult {
  if (!ctx.hasAuthLib) {
    return notApplicable(check, '项目未使用认证/会话库，Cookie 属性没有可检对象');
  }
  const missing: string[] = [];
  if (source.cookieHttpOnly.length === 0) missing.push('httpOnly');
  if (source.cookieSecure.length === 0) missing.push('secure');
  if (source.cookieSameSite.length === 0) missing.push('sameSite');
  if (missing.length === 0) {
    return passed(check, '检出 httpOnly / secure / SameSite 三项 Cookie 属性');
  }
  return failed(check, `未检出 Cookie 属性：${missing.join('、')}（源码模式检测）`);
}

function tokenExpiryVerdict(
  check: string,
  ctx: ConfigContext,
  source: SourceEvidence,
): SecurityCheckResult {
  if (!ctx.hasJwtLib) {
    return notApplicable(check, '项目未使用 JWT 库，令牌有效期没有可检对象');
  }
  if (source.tokenExpiry.length > 0) {
    return passed(check, `检出令牌有效期配置（${firstHit(source.tokenExpiry)}）`);
  }
  return failed(check, '未检出 JWT expiresIn 配置，令牌可能没有有效期（源码模式检测）');
}

function passwordHashingVerdict(
  check: string,
  ctx: ConfigContext,
  source: SourceEvidence,
): SecurityCheckResult {
  if (!ctx.hasAuthLib) {
    return notApplicable(check, '项目未使用认证库，密码哈希没有可检对象');
  }
  if (source.passwordHashing.length > 0) {
    return passed(check, `检出密码哈希调用（${firstHit(source.passwordHashing)}）`);
  }
  return failed(check, '未检出 bcrypt / argon2 / scrypt 等密码哈希调用（源码模式检测）');
}

function auditLogVerdict(
  check: string,
  ctx: ConfigContext,
  source: SourceEvidence,
): SecurityCheckResult {
  if (!ctx.hasWebFramework && !ctx.hasLoggerLib) {
    return notApplicable(check, '项目没有服务端或日志面，审计日志没有可检对象');
  }
  if (source.auditLog.length > 0) {
    return passed(check, `检出审计日志调用（${firstHit(source.auditLog)}）`);
  }
  return failed(check, '未检出安全审计日志调用（登录失败 / 越权 / 权限拒绝等事件）');
}

/** 密钥材料是否存在于本项目（决定轮换/密钥管理是否适用） */
function usesKeyMaterial(ctx: ConfigContext): boolean {
  return ctx.hasCryptoUsage || ctx.hasKeyLib || ctx.hasAuthLib;
}

function keyMechanismVerdict(
  check: string,
  ctx: ConfigContext,
  hits: SourceHit[],
  spec: { mechanism: string; missing: string },
): SecurityCheckResult {
  if (!usesKeyMaterial(ctx)) {
    return notApplicable(check, '项目未使用密钥材料，本项没有可检对象');
  }
  if (hits.length > 0) {
    return passed(check, `检出${spec.mechanism}（${firstHit(hits)}）`);
  }
  return failed(check, `${spec.missing}（源码模式检测）`);
}

function supplySignatureVerdict(
  check: string,
  ctx: ConfigContext,
  source: SourceEvidence,
): SecurityCheckResult {
  if (!ctx.hasDependencies) {
    return notApplicable(check, '项目没有依赖清单，供应链签名校验没有可检对象');
  }
  if (ctx.hasSignatureScript || source.signatureVerification.length > 0) {
    const at = firstHit(source.signatureVerification);
    return passed(check, at ? `检出依赖签名/来源校验命令（${at}）` : '检出依赖签名/来源校验脚本');
  }
  return failed(
    check,
    '未检出依赖签名/来源校验（npm audit signatures / cosign / gpg / attestations）',
  );
}

/**
 * 配置类 check 的统一入口：命中返回结论，未命中返回 null 交给既有判定阶段。
 */
export function evaluateConfigCheck(
  check: string,
  source: SourceEvidence,
  ctx: ConfigContext,
): SecurityCheckResult | null {
  switch (check) {
    case 'header-content-security-policy':
      return headerVerdict(check, ctx, source.helmetCall, {
        label: 'CSP',
        disabled: source.cspDisabled,
        configured: source.cspConfigured,
      });
    case 'header-hsts':
      return hstsVerdict(check, ctx, source);
    case 'header-frame-options':
      return headerVerdict(check, ctx, source.helmetCall, {
        label: 'X-Frame-Options',
        disabled: source.frameDisabled,
        configured: source.frameConfigured,
      });
    case 'session-cookie-flags':
      return sessionCookieVerdict(check, ctx, source);
    case 'token-expiry':
      return tokenExpiryVerdict(check, ctx, source);
    case 'password-hashing':
      return passwordHashingVerdict(check, ctx, source);
    case 'audit-log-events':
      return auditLogVerdict(check, ctx, source);
    case 'key-rotation-mechanism':
      return keyMechanismVerdict(check, ctx, source.keyRotation, {
        mechanism: '密钥轮换机制',
        missing: '未检出密钥轮换机制（版本号 / KMS reEncrypt / rotate 流程）',
      });
    case 'key-management-service':
      return keyMechanismVerdict(check, ctx, source.keyManagement, {
        mechanism: '集中密钥管理配置',
        missing: '未检出 KMS / Vault 等集中密钥管理；若密钥由环境变量手工管理，轮换需人工保证',
      });
    case 'supply-signature-verification':
      return supplySignatureVerdict(check, ctx, source);
  }
  return null;
}

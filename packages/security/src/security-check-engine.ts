import * as fs from 'node:fs';
import * as path from 'node:path';
import { InjectionGuard } from './injection-guard';
import { scanNpmThreats } from './npm-threat-scanner';
import type { MalwareItem } from './types';
import { PACKAGE_JSON_FILE } from './scan-walk';
import { SIGNATURE_VERIFICATION_RE, scanSourceEvidence, walkFiles } from './security-config-scan';
import type { SourceEvidence, SourceHit } from './security-config-scan';
import { evaluateConfigCheck, makeVerdict } from './security-config-checks';
import type { ConfigContext } from './security-config-checks';
import type { SecurityCheckResult } from './security-check-result';

/** 类型从独立模块透出，保持既有 `@zh/security` 导出路径不变 */
export type { SecurityCheckResult } from './security-check-result';

const HELMET_PKG = 'helmet';
const WEB_FRAMEWORK_MARKERS = [
  'express',
  '@nestjs/core',
  '@nestjs/common',
  'fastify',
  'koa',
  'hapi',
];
const CSRF_LIBS = ['csurf', '@fastify/csrf-protection', 'tiny-csrf', '@nestjs/throttler'];
/** 认证/会话库：决定会话 Cookie 与密码哈希检查是否适用 */
const AUTH_LIBS = [
  'jsonwebtoken',
  'jose',
  'passport',
  'express-session',
  'cookie-session',
  'next-auth',
  'bcrypt',
  'bcryptjs',
  'argon2',
  '@node-rs/argon2',
  'lucia',
  '@auth/core',
  'iron-session',
  '@nestjs/jwt',
  '@nestjs/passport',
  '@fastify/jwt',
  '@fastify/session',
  '@fastify/cookie',
];
const JWT_LIBS = [
  'jsonwebtoken',
  'jose',
  '@nestjs/jwt',
  '@fastify/jwt',
  'next-auth',
  '@auth/core',
];
const LOGGER_LIBS = ['winston', 'pino', 'bunyan', 'log4js'];
const KEY_LIBS = [
  '@aws-sdk/client-kms',
  '@aws-sdk/client-secrets-manager',
  'node-vault',
  '@azure/keyvault-keys',
  '@google-cloud/kms',
  'keytar',
];

/** 非注册表来源的依赖版本声明（本地文件 / workspace 协议 / git 远程）——依赖混淆的本地遮蔽面 */
const NON_REGISTRY_VERSION_RE =
  /^(?:file:|workspace:|link:|git\+|github:|\.\.?\/)|^git\+(?:ssh|https):/;

interface DepsScan {
  hasWebFramework: boolean;
  hasHelmet: boolean;
  hasCsrfLib: boolean;
  hasAuthLib: boolean;
  hasJwtLib: boolean;
  hasLoggerLib: boolean;
  hasKeyLib: boolean;
  hasDependencies: boolean;
  /** package.json scripts 里已声明依赖签名/来源校验命令 */
  hasSignatureScript: boolean;
  evidence: string[];
  /** 未加作用域且来自本地/git 来源的依赖名（依赖混淆遮蔽面） */
  localUnscopedDeps: string[];
}

interface EvaluateCheckParams {
  check: string;
  items: MalwareItem[];
  threats: MalwareItem[];
  deps: DepsScan;
  source: SourceEvidence;
}

/**
 * 单个依赖区块的每条声明并入扫描结论：helmet 证据 / CSRF 库 / Web 框架标记 /
 * 非注册表版本遮蔽面。独立于类体以避免 scanDependencies 的循环嵌套超过两层。
 */
function applyDepEntries(
  scan: DepsScan,
  rel: string,
  section: string,
  deps: Record<string, unknown>,
): void {
  for (const [name, version] of Object.entries(deps)) {
    scan.hasDependencies = true;
    if (name === HELMET_PKG) {
      scan.hasHelmet = true;
      scan.evidence.push(`${rel}[${section}]: helmet`);
    }
    if (CSRF_LIBS.includes(name)) {
      scan.hasCsrfLib = true;
    }
    if (AUTH_LIBS.includes(name)) {
      scan.hasAuthLib = true;
    }
    if (JWT_LIBS.includes(name)) {
      scan.hasJwtLib = true;
    }
    if (LOGGER_LIBS.includes(name)) {
      scan.hasLoggerLib = true;
    }
    if (KEY_LIBS.includes(name)) {
      scan.hasKeyLib = true;
    }
    if (WEB_FRAMEWORK_MARKERS.some((m) => name === m || name.startsWith(m.replace('*', '')))) {
      scan.hasWebFramework = true;
    }
    if (
      typeof version === 'string' &&
      NON_REGISTRY_VERSION_RE.test(version) &&
      !name.startsWith('@') && // 有 @scope 的本地包不构成可抢占公共命名空间
      !NAME_EXEMPT_SET.has(name)
    ) {
      scan.localUnscopedDeps.push(name);
    }
  }
}

/** 读取并解析 package.json；缺失或非法返回 null */
function readPackageJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** scripts 里的签名/来源校验命令（如 `npm audit signatures`）并入扫描结论 */
function applyScriptEntries(scan: DepsScan, parsed: Record<string, unknown>): void {
  const scripts = parsed.scripts;
  if (typeof scripts !== 'object' || scripts === null) return;
  for (const command of Object.values(scripts as Record<string, unknown>)) {
    if (typeof command === 'string' && SIGNATURE_VERIFICATION_RE.test(command)) {
      scan.hasSignatureScript = true;
      return;
    }
  }
}

/** 依赖清单 + 源码证据 → 配置类判定的项目形态上下文 */
function configContext(deps: DepsScan, source: SourceEvidence): ConfigContext {
  return {
    hasWebFramework: deps.hasWebFramework,
    hasHelmet: deps.hasHelmet,
    hasAuthLib: deps.hasAuthLib,
    hasJwtLib: deps.hasJwtLib,
    hasLoggerLib: deps.hasLoggerLib,
    hasKeyLib: deps.hasKeyLib,
    hasDependencies: deps.hasDependencies,
    hasSignatureScript: deps.hasSignatureScript,
    hasCryptoUsage: source.cryptoUsage.length > 0,
  };
}

/**
 * SecurityCheckEngine — security 域 check-list 规则的真实检测引擎。
 *
 * 接收 { mode, target, checks, dryRun }：checks 为规则 content.checks 的语义化
 * 检查名（字符串条目，如 helmet-configured / csrf-token-present）。对每条执行对应
 * 检测，返回符合 GuardEngineLike 契约的结果数组（failed|error → violation）。
 *
 * 检测能力：
 *   - InjectionGuard：注释指令注入（comment-instruction 4 项）、package.json 脚本
 *     注入（dependency-scripts 4 项 / supply-chain.suspicious-postinstall-script）、
 *     .env 文件跟踪（env-tracked-in-scan-set）、markdown 隐藏链接（hidden-link 2 项）；
 *   - scanNpmThreats：typosquatting（package-name-typosquatting）、已知恶意包
 *     （known-malicious-packages）；
 *   - 本项目启发式：helmet 中间件（helmet-check 4 项）、CSRF 防护源码证据
 *     （csrf-check 3 项）、env 值出站请求（env-value-outbound-request）、依赖混淆
 *     本地遮蔽面（dependency-confusion）。
 *
 * 未知检查名返回 status 'error'（诚实表达，不静默判通过）。
 */
export class SecurityCheckEngine {
  async run(opts: unknown): Promise<{ results: SecurityCheckResult[] }> {
    const o = (opts ?? {}) as {
      mode?: string;
      target?: string;
      checks?: string[];
      dryRun?: boolean;
    };
    const target = o.target ?? '';
    const checks = Array.isArray(o.checks) ? o.checks : [];
    if (!target) {
      return {
        results: checks.map((c) => ({
          status: 'error',
          message: `安全检查失败: 未指定 target（检查: ${c}）`,
        })),
      };
    }
    const items = await new InjectionGuard().scan(target);
    const threats = await scanNpmThreats(target);
    const deps = this.scanDependencies(target);
    // env-value-outbound-request 与 Web 框架无关，源码证据需无条件扫描；
    // csrf 三项是否适用由 csrfVerdict 内部按 hasWebFramework 自判
    const source = scanSourceEvidence(target);
    return {
      results: checks.map((check) => this.evaluateCheck({ check, items, threats, deps, source })),
    };
  }

  // 顺序分段判定：各段接管互不相交的检查名集合，未命中返回 null 顺延下一段（与原 switch 语义一致）
  private evaluateCheck(params: EvaluateCheckParams): SecurityCheckResult {
    const evidence = this.itemEvidenceVerdict(params);
    if (evidence !== null) return evidence;
    const dependency = this.dependencyVerdict(params);
    if (dependency !== null) return dependency;
    const threats = this.threatDbVerdict(params);
    if (threats !== null) return threats;
    const config = evaluateConfigCheck(
      params.check,
      params.source,
      configContext(params.deps, params.source),
    );
    if (config !== null) return config;
    return this.guardPatternVerdict(params);
  }

  private itemEvidenceVerdict(params: EvaluateCheckParams): SecurityCheckResult | null {
    const { check, items, source } = params;
    switch (check) {
      case 'env-tracked-in-scan-set':
        // InjectionGuard 的 .env 检出以 title 标识（pattern 为文件名，无法按下发名匹配）
        return makeVerdict(
          check,
          items.filter((i) => i.title.startsWith("'.env'")),
          (i) => `${i.evidence}`,
        );
      case 'env-value-outbound-request':
        return makeVerdict(
          check,
          source.outboundValue,
          (i) => `${i.file}:${i.line} ${i.evidence}`,
        );
      case 'tls-verification-disabled':
        return this.tlsVerdict(check, source.tlsVerifyDisabled);
      case 'weak-tls-protocol':
        return this.tlsVerdict(check, source.weakTlsProtocol);
      case 'hidden-anchor-style':
      case 'zero-width-link-target':
        return makeVerdict(
          check,
          items.filter(
            (i) =>
              i.pattern ===
              (check === 'hidden-anchor-style' ? 'hidden-anchor' : 'zero-width-target'),
          ),
          (i) => `${i.file}:${i.line} ${i.evidence}`,
        );
    }
    return null;
  }

  private dependencyVerdict(params: EvaluateCheckParams): SecurityCheckResult | null {
    const { check, deps, source } = params;
    switch (check) {
      case 'helmet-configured':
      case 'content-security-policy':
      case 'x-frame-options':
      case 'strict-transport-security':
        return this.helmetVerdict(check, deps);
      case 'csrf-token-present':
      case 'same-site-cookie':
      case 'origin-header-validation':
        return this.csrfVerdict(check, deps, source);
      case 'dependency-confusion':
        return this.dependencyConfusionVerdict(check, deps);
    }
    return null;
  }

  private dependencyConfusionVerdict(check: string, deps: DepsScan): SecurityCheckResult {
    if (deps.localUnscopedDeps.length === 0) {
      return {
        status: 'passed',
        message: `${check}: 未发现未加作用域（可被公共源抢占）的本地/git 依赖`,
      };
    }
    return {
      status: 'failed',
      message: `${check}: 检测到 ${deps.localUnscopedDeps.length} 个本地/git 来源依赖缺少 @scope 前缀，存在被同名公共包抢占的风险（${deps.localUnscopedDeps.slice(0, 5).join(', ')}）`,
    };
  }

  private threatDbVerdict(params: EvaluateCheckParams): SecurityCheckResult | null {
    const { check, items, threats } = params;
    switch (check) {
      case 'package-name-typosquatting':
        return makeVerdict(
          check,
          threats.filter((i) => i.pattern.startsWith('typosquat:')),
          (i) => `${i.evidence}`,
        );
      case 'known-malicious-packages':
        return makeVerdict(
          check,
          threats.filter((i) => i.pattern === 'npm-threat-db'),
          (i) => `${i.evidence}`,
        );
      case 'suspicious-postinstall-script':
        // package.json 脚本注入由 InjectionGuard 以 type='supply-chain' 产出
        return makeVerdict(
          check,
          items.filter((i) => i.type === 'supply-chain'),
          (i) => `${i.file}:${i.title}`,
        );
    }
    return null;
  }

  private guardPatternVerdict(params: EvaluateCheckParams): SecurityCheckResult {
    const { check, items } = params;
    // comment-instruction 4 项 / dependency-scripts 4 项 → InjectionGuard pattern 名直接匹配
    const KNOWN_PATTERNS = new Set([
      'ignore-previous-instructions',
      'disregard-rules',
      'system-prompt-reference',
      'identity-takeover',
      'remote-content-piped-to-shell',
      'base64-decode-execution',
      'eval-usage',
      'force-delete',
    ]);
    if (KNOWN_PATTERNS.has(check)) {
      return makeVerdict(
        check,
        items.filter((i) => i.pattern === check),
        (i) => `${i.file}:${i.line} ${i.evidence}`,
      );
    }
    return { status: 'error', message: `${check}: 未知检查项，安全引擎未实现该检测` };
  }

  /**
   * TLS 源码配置判定：命中即失败；未命中**只**表示「未检出已知不安全写法」，
   * 不表示「传输加密已合规」——运行时/部署侧配置不在源码扫描的可见范围。
   * 该限定写进通过文案，避免 0 命中被读成已验证（C4：未检测 ≠ 通过）。
   */
  private tlsVerdict(check: string, hits: SourceHit[]): SecurityCheckResult {
    if (hits.length === 0) {
      return {
        status: 'passed',
        message: `${check}: 未检出已知不安全的 TLS 源码配置（源码模式检测，不覆盖运行期/部署侧配置）`,
      };
    }
    const samples = hits
      .slice(0, 3)
      .map((h) => `${h.file}:${h.line} ${h.evidence}`)
      .join('; ');
    return { status: 'failed', message: `${check}: 检测到 ${hits.length} 处 TLS 配置风险（${samples}）` };
  }

  private helmetVerdict(check: string, deps: DepsScan): SecurityCheckResult {
    if (!deps.hasWebFramework) {
      // 无 Web 框架 ⇒ 响应头中间件没有装配位置，属「确知不适用」。
      // 与「已通过」区分：CLI/面板据此显示「不适用」，不把它算作已验证的安全能力。
      return {
        status: 'passed',
        applicability: 'not-applicable',
        message: `${check}: 项目未使用 Express/NestJS 等 Web 框架，Helmet 检查不适用`,
      };
    }
    if (deps.hasHelmet) {
      return {
        status: 'passed',
        message: `${check}: 已启用 Helmet（${deps.evidence[0] ?? 'helmet 依赖已安装'}）`,
      };
    }
    return {
      status: 'failed',
      message: `${check}: 项目使用 Web 框架但未启用 Helmet 中间件，缺少安全响应头保护`,
    };
  }

  private csrfVerdict(check: string, deps: DepsScan, source: SourceEvidence): SecurityCheckResult {
    if (!deps.hasWebFramework) {
      // 同 helmet：无 Web 框架 ⇒ CSRF 防护没有落点，属确知不适用。
      // 注意「零目标文件」不等于不适用（可能是扫描失败或路径裁剪），
      // 该场景无法判定，不在此处猜测，保持原有 passed/failed 判定。
      return {
        status: 'passed',
        applicability: 'not-applicable',
        message: `${check}: 项目未使用 Web 框架，CSRF 防护检查不适用`,
      };
    }
    const bucket =
      check === 'csrf-token-present'
        ? source.csrfToken
        : check === 'same-site-cookie'
          ? source.sameSite
          : source.originCheck;
    if (bucket.length > 0) {
      const samples = bucket
        .slice(0, 3)
        .map((h) => `${h.file}:${h.line}`)
        .join(', ');
      return { status: 'passed', message: `${check}: 检测到防护证据（${samples}）` };
    }
    return { status: 'failed', message: `${check}: 未检测到 ${check} 的防护实现` };
  }

  private scanDependencies(target: string): DepsScan {
    const scan: DepsScan = {
      hasWebFramework: false,
      hasHelmet: false,
      hasCsrfLib: false,
      hasAuthLib: false,
      hasJwtLib: false,
      hasLoggerLib: false,
      hasKeyLib: false,
      hasDependencies: false,
      hasSignatureScript: false,
      evidence: [],
      localUnscopedDeps: [],
    };
    const files: string[] = [];
    walkFiles(target, 0, files, new Set([PACKAGE_JSON_FILE]));
    for (const file of files) {
      const parsed = readPackageJson(file);
      if (parsed === null) continue;
      const rel = path.relative(target, file);
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const deps = parsed[section];
        if (typeof deps !== 'object' || deps === null) continue;
        applyDepEntries(scan, rel, section, deps as Record<string, unknown>);
      }
      applyScriptEntries(scan, parsed);
    }
    return scan;
  }

}

/** 本地/git 来源但无 @scope 的标准工具包名豁免（构建工具链自身的本地固化，非依赖混淆面） */
const NAME_EXEMPT_SET = new Set(['typescript', 'vite', 'rollup', 'tsx', 'ts-node', 'esbuild']);

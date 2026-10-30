import * as fs from 'node:fs';
import * as path from 'node:path';
import { InjectionGuard } from './injection-guard';
import { scanNpmThreats } from './npm-threat-scanner';
import type { MalwareItem } from './types';
import { MAX_SCAN_DEPTH, PACKAGE_JSON_FILE, SKIP_DIRS } from './scan-walk';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue']);
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
const OUTBOUND_RE =
  /(?:fetch|axios(?:\.\w+)?|curl|https?\.(?:get|post|put|delete|request)|XMLHttpRequest|WebSocket)\s*\(?[^)\n]*(?:process\.env|import\.meta\.env)/i;
const ENV_ACCESS_RE = /(?:process\.env|import\.meta\.env)/;
const CSRF_TOKEN_USAGE_RE =
  /csrf\s*\(\s*\{|csrfToken\s*\(|X-CSRF(?:-Token)?[:=]|csrfProtection|app\.use\s*\(\s*(?:csurf|csrf)\b/i;
const SAME_SITE_RE = /(?:sameSite\s*[:=]\s*(['"])(lax|strict|none)\1|SameSite=(Lax|Strict|None))/i;
const ORIGIN_CHECK_RE =
  /\.headers\.origin|\[['"]origin['"]\]|checkOrigin|allowedOrigin|verifyOrigin/i;
/** 非注册表来源的依赖版本声明（本地文件 / workspace 协议 / git 远程）——依赖混淆的本地遮蔽面 */
const NON_REGISTRY_VERSION_RE =
  /^(?:file:|workspace:|link:|git\+|github:|\.\.?\/)|^git\+(?:ssh|https):/;
/** 引擎自身实现文件名（无扩展名）：源码证据扫描需排除，避免 regex 定义行自匹配伪证据 */
const SELF_BASENAME = 'security-check-engine';

interface DepsScan {
  hasWebFramework: boolean;
  hasHelmet: boolean;
  hasCsrfLib: boolean;
  evidence: string[];
  /** 未加作用域且来自本地/git 来源的依赖名（依赖混淆遮蔽面） */
  localUnscopedDeps: string[];
}

interface OutboundHit {
  file: string;
  line: number;
  evidence: string;
}

interface SourceEvidence {
  csrfToken: OutboundHit[];
  sameSite: OutboundHit[];
  originCheck: OutboundHit[];
  outboundValue: OutboundHit[];
}

/** 单条 check 的检测结论：passed / failed（命中风险）/ error（检测执行异常），
 *  由 SecurityCheckEngine 转为 GuardEngine 契约的 violation 列表 */
export interface SecurityCheckResult {
  status: 'passed' | 'failed' | 'error';
  message?: string;
  /**
   * 不适用标注：检测项在本项目**确实不存在可检对象**（如未使用 Web 框架时的
   * Helmet/CSRF 要求）。仅作为附加语义，status 仍为 passed —— 不新增顶层状态，
   * 避免破坏既有消费方（GuardEngine 契约、SARIF、评分）的 schema。
   *
   * 只在「确知不适用」处设置；无法判定时不得猜测（宁可保持 passed/failed 现状）。
   */
  applicability?: 'not-applicable';
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
    if (name === HELMET_PKG) {
      scan.hasHelmet = true;
      scan.evidence.push(`${rel}[${section}]: helmet`);
    }
    if (CSRF_LIBS.includes(name)) {
      scan.hasCsrfLib = true;
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
    const source = this.scanSourceEvidence(target);
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
    return this.guardPatternVerdict(params);
  }

  private itemEvidenceVerdict(params: EvaluateCheckParams): SecurityCheckResult | null {
    const { check, items, source } = params;
    switch (check) {
      case 'env-tracked-in-scan-set':
        // InjectionGuard 的 .env 检出以 title 标识（pattern 为文件名，无法按下发名匹配）
        return this.verdict(
          check,
          items.filter((i) => i.title.startsWith("'.env'")),
          (i) => `${i.evidence}`,
        );
      case 'env-value-outbound-request':
        return this.verdict(
          check,
          source.outboundValue,
          (i) => `${i.file}:${i.line} ${i.evidence}`,
        );
      case 'hidden-anchor-style':
      case 'zero-width-link-target':
        return this.verdict(
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
        return this.verdict(
          check,
          threats.filter((i) => i.pattern.startsWith('typosquat:')),
          (i) => `${i.evidence}`,
        );
      case 'known-malicious-packages':
        return this.verdict(
          check,
          threats.filter((i) => i.pattern === 'npm-threat-db'),
          (i) => `${i.evidence}`,
        );
      case 'suspicious-postinstall-script':
        // package.json 脚本注入由 InjectionGuard 以 type='supply-chain' 产出
        return this.verdict(
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
      return this.verdict(
        check,
        items.filter((i) => i.pattern === check),
        (i) => `${i.file}:${i.line} ${i.evidence}`,
      );
    }
    return { status: 'error', message: `${check}: 未知检查项，安全引擎未实现该检测` };
  }

  private verdict<T>(check: string, hits: T[], describe: (item: T) => string): SecurityCheckResult {
    if (hits.length === 0) {
      return { status: 'passed', message: `${check}: 未发现风险` };
    }
    const samples = hits.slice(0, 3).map(describe).join('; ');
    return { status: 'failed', message: `${check}: 检测到 ${hits.length} 处风险（${samples}）` };
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
      evidence: [],
      localUnscopedDeps: [],
    };
    const files: string[] = [];
    this.walk(target, 0, files, new Set([PACKAGE_JSON_FILE]));
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rel = path.relative(target, file);
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const deps = (parsed as Record<string, unknown>)[section];
        if (typeof deps !== 'object' || deps === null) continue;
        applyDepEntries(scan, rel, section, deps as Record<string, unknown>);
      }
    }
    return scan;
  }

  private scanSourceEvidence(target: string): SourceEvidence {
    const evidence: SourceEvidence = {
      csrfToken: [],
      sameSite: [],
      originCheck: [],
      outboundValue: [],
    };
    const files: string[] = [];
    this.walk(target, 0, files, SOURCE_EXTS);
    for (const file of files) {
      // 排除引擎自身实现文件：其 regex 常量定义行会匹配自家模式，
      // 把「检测器定义」误计为被检项目的防护证据（自匹配伪证据）
      if (path.basename(file, path.extname(file)) === SELF_BASENAME) continue;
      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const rel = path.relative(target, file);
      content.split('\n').forEach((line, idx) => {
        const trim = line.trim();
        if (trim.length === 0 || trim.startsWith('//')) return;
        // 出站请求携带 env 值（fetch/axios/curl/http 命中且行内含 process.env / import.meta.env）
        if (OUTBOUND_RE.test(line) && ENV_ACCESS_RE.test(line)) {
          evidence.outboundValue.push({ file: rel, line: idx + 1, evidence: trim.slice(0, 120) });
        }
        if (CSRF_TOKEN_USAGE_RE.test(line)) {
          evidence.csrfToken.push({ file: rel, line: idx + 1, evidence: trim.slice(0, 120) });
        }
        if (SAME_SITE_RE.test(line)) {
          evidence.sameSite.push({ file: rel, line: idx + 1, evidence: trim.slice(0, 120) });
        }
        if (ORIGIN_CHECK_RE.test(line)) {
          evidence.originCheck.push({ file: rel, line: idx + 1, evidence: trim.slice(0, 120) });
        }
      });
    }
    return evidence;
  }

  private walk(dir: string, depth: number, out: string[], exts: Set<string>): void {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        this.walk(path.join(dir, entry.name), depth + 1, out, exts);
        continue;
      }
      if (!entry.isFile()) continue;
      // PACKAGE_JSON_FILE 以精确文件名匹配；源码走扩展名匹配
      if (exts.has(entry.name) || exts.has(path.extname(entry.name).toLowerCase())) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
}

/** 本地/git 来源但无 @scope 的标准工具包名豁免（构建工具链自身的本地固化，非依赖混淆面） */
const NAME_EXEMPT_SET = new Set(['typescript', 'vite', 'rollup', 'tsx', 'ts-node', 'esbuild']);

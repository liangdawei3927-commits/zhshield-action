/**
 * 安全配置源码扫描（SecurityCheckEngine 的证据来源）。
 *
 * 为什么独立成模块：SecurityCheckEngine 的类体已顶到 zhcheck `large-class`
 * 300 行阈值；把「遍历 + 正则取证」提为模块级纯函数后，类只留判定与派发。
 *
 * 证据语义：这里只产出**位置与原文片段**，不下结论。passed / failed 由
 * security-config-checks 判定；未命中一律不猜测（C4：未检测 ≠ 通过）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAX_SCAN_DEPTH, SKIP_DIRS } from './scan-walk';

/** 源码证据命中位置（文件 / 行号 / 截断后的原文） */
export interface SourceHit {
  file: string;
  line: number;
  evidence: string;
}

/** 源码证据桶：每个桶只回答「有没有出现这类写法」，不回答「配置是否真的生效」 */
export interface SourceEvidence {
  csrfToken: SourceHit[];
  sameSite: SourceHit[];
  originCheck: SourceHit[];
  outboundValue: SourceHit[];
  /** TLS 证书校验被关闭的源码位置 */
  tlsVerifyDisabled: SourceHit[];
  /** 弱 TLS 协议 / 弱加密套件 */
  weakTlsProtocol: SourceHit[];
  /** helmet 装配调用（`app.use(helmet(...)` / `helmet()`），不含 import 行 */
  helmetCall: SourceHit[];
  cspDisabled: SourceHit[];
  cspConfigured: SourceHit[];
  hstsDisabled: SourceHit[];
  hstsConfigured: SourceHit[];
  /** HSTS maxAge 低于 180 天 */
  hstsWeak: SourceHit[];
  frameDisabled: SourceHit[];
  frameConfigured: SourceHit[];
  cookieHttpOnly: SourceHit[];
  cookieSecure: SourceHit[];
  cookieSameSite: SourceHit[];
  tokenExpiry: SourceHit[];
  passwordHashing: SourceHit[];
  cryptoUsage: SourceHit[];
  auditLog: SourceHit[];
  keyRotation: SourceHit[];
  keyManagement: SourceHit[];
  /** 依赖签名/来源校验命令（CI workflow 与源码内脚本） */
  signatureVerification: SourceHit[];
}

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue']);

/**
 * 引擎自身实现文件名（无扩展名）：其 regex 常量定义行会匹配自家模式，
 * 把「检测器定义」误计为被检项目的证据（自匹配伪证据）。
 */
const SELF_BASENAMES = new Set([
  'security-check-engine',
  'security-config-scan',
  'security-config-checks',
]);

const OUTBOUND_RE =
  /(?:fetch|axios(?:\.\w+)?|curl|https?\.(?:get|post|put|delete|request)|XMLHttpRequest|WebSocket)\s*\(?[^)\n]*(?:process\.env|import\.meta\.env)/i;
const ENV_ACCESS_RE = /(?:process\.env|import\.meta\.env)/;
const CSRF_TOKEN_USAGE_RE =
  /csrf\s*\(\s*\{|csrfToken\s*\(|X-CSRF(?:-Token)?[:=]|csrfProtection|app\.use\s*\(\s*(?:csurf|csrf)\b/i;
const SAME_SITE_RE = /(?:sameSite\s*[:=]\s*(['"])(lax|strict|none)\1|SameSite=(Lax|Strict|None))/i;
const ORIGIN_CHECK_RE =
  /\.headers\.origin|\[['"]origin['"]\]|checkOrigin|allowedOrigin|verifyOrigin/i;

/**
 * TLS 证书校验被显式关闭 —— 连接退化为可被中间人劫持（ASVS 9.1）。
 *
 * 只收「明确写出关闭」的写法（rejectUnauthorized: false / NODE_TLS_REJECT_UNAUTHORIZED=0 /
 * insecureSkipVerify / strictSSL: false / 把 checkServerIdentity 写成恒返回空值的箭头函数）。
 * 没有显式关闭的连接不发结论：源码模式判不出「是否真的校验证书」，猜测会制造假阳性。
 */
const TLS_VERIFY_DISABLED_RE =
  /rejectUnauthorized\s*:\s*false|insecureSkipVerify\s*:\s*true|strictSSL\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*(['"]?)0\1|checkServerIdentity\s*:\s*(?:async\s*)?(?:\(\s*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:undefined|null|\{\s*\})/i;

/** 弱 TLS/SSL 协议或弱加密套件：TLSv1.0/1.1 及更早、RC4 / 3DES / MD5（ASVS 9.1） */
const WEAK_TLS_PROTOCOL_RE =
  /(?:minVersion|maxVersion)\s*:\s*['"](?:TLSv1(?:\.(?:0|1))?|SSLv3)['"]|secureProtocol\s*:\s*['"](?:TLSv1|TLSv1_1|SSLv3|SSLv2)_method|ciphers\s*:\s*['"][^'"]*(?:RC4|3DES|DES|MD5)/i;

/** TLS 相关行的前置过滤：只有可能承载 TLS 配置的行才跑上面两条正则 */
const TLS_INTEREST_RE =
  /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|insecureSkipVerify|strictSSL|checkServerIdentity|minVersion|maxVersion|secureProtocol|ciphers/i;

const HELMET_CALL_RE = /helmet\s*\(/i;
const CSP_DISABLED_RE = /contentSecurityPolicy\s*:\s*false|Content-Security-Policy[^\n]*\b(?:false|null|''|"")\b/i;
const CSP_CONFIGURED_RE = /contentSecurityPolicy|Content-Security-Policy/i;
const HSTS_DISABLED_RE = /(?:strictTransportSecurity|hsts)\s*:\s*false/i;
const HSTS_CONFIGURED_RE = /strictTransportSecurity|Strict-Transport-Security|hsts\s*[:.(]/i;
const HSTS_MAX_AGE_RE = /(?:max-age\s*=\s*(\d+)|maxAge\s*:\s*(\d+))/i;
/** OWASP 建议 HSTS 至少 180 天（15552000 秒） */
const HSTS_MIN_MAX_AGE = 15_552_000;
const FRAME_DISABLED_RE = /(?:frameguard|xFrameOptions|X-Frame-Options)[^\n]*\b(?:false|null)\b/i;
const FRAME_CONFIGURED_RE = /frameguard|X-Frame-Options/i;

const COOKIE_HTTP_ONLY_RE = /httpOnly\s*:\s*true/i;
const COOKIE_SECURE_RE = /secure\s*:\s*true/i;
const COOKIE_SAME_SITE_RE = /sameSite\s*:\s*(?:true|['"](?:lax|strict|none)['"])/i;
const TOKEN_EXPIRY_RE = /expiresIn\s*:/i;
const PASSWORD_HASHING_RE = /bcrypt(?:js)?\.hash|argon2\.hash|scryptSync?\s*\(/i;
/**
 * 密钥材料使用：加密/解密、密钥对生成、HMAC、签名/验签。
 * `timingSafeEqual` 刻意不计入——它只是常量时间比较（比对令牌/摘要），
 * 不持有可轮换的密钥；计进来会把「仅做安全比较」的项目误判为需要密钥轮换。
 */
const CRYPTO_USAGE_RE =
  /(?:createCipheriv|createDecipheriv|generateKeyPair|createHmac|createSign|createVerify)\s*\(/i;

const AUDIT_LOG_RE =
  /(?:auditLog|securityAudit|audit\.(?:log|record|event|write)|logSecurityEvent|logger\.(?:info|warn|error)\s*\([^)\n]*(?:auth|login|logout|permission|forbidden|unauthori[sz]ed|denied|privilege))/i;
const KEY_ROTATION_RE =
  /(?:rotate(?:Key|Keys)|keyRotation|rotationInterval|keyVersion|keyId|generateDataKey|reEncrypt|rotate-secret)/i;
const KEY_MANAGEMENT_RE =
  /(?:@aws-sdk\/client-kms|@aws-sdk\/client-secrets-manager|node-vault|@azure\/keyvault|@google-cloud\/kms|keytar|vault\.|secretsManager|kms\.)/i;

/** 依赖签名 / 来源校验命令（CI workflow 与 package.json scripts 共用同一份） */
export const SIGNATURE_VERIFICATION_RE =
  /(?:npm\s+audit\s+signatures|cosign\s+verify|sigstore|slsa-verifier|gpg\s+(?:--verify|-v)|attest-build-provenance|actions\/attest|verify-attestation|npm\s+provenance)/i;

/**
 * 配置类检查的前置过滤：命中任意关键词才逐条跑下面十余条正则。
 * 目的不是省一次正则，而是避免「每行二十条正则」把大仓扫描拖慢一个数量级。
 */
const CONFIG_INTEREST_RE =
  /helmet|contentSecurityPolicy|content-security-policy|strictTransportSecurity|strict-transport-security|hsts|frameguard|x-frame-options|httpOnly|secure\s*:\s*true|sameSite|expiresIn|bcrypt|argon2|scrypt|audit|logger|rotate|keyVersion|keyId|kms|vault|secretsManager|createCipheriv|generateKeyPair|createHmac/i;

/** 递归收集被检文件（按扩展名或精确文件名） */
export function walkFiles(dir: string, depth: number, out: string[], exts: Set<string>): void {
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
      walkFiles(path.join(dir, entry.name), depth + 1, out, exts);
      continue;
    }
    if (!entry.isFile()) continue;
    // package.json 以精确文件名匹配；源码走扩展名匹配
    if (exts.has(entry.name) || exts.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function hitOf(rel: string, lineNo: number, trim: string): SourceHit {
  return { file: rel, line: lineNo, evidence: trim.slice(0, 120) };
}

/** HSTS maxAge 解析：`max-age=...` / `maxAge: ...`，无值不算弱配置 */
function isWeakHsts(line: string): boolean {
  // 必须先确认这一行真的在配置 HSTS：Set-Cookie 的 `Max-Age=0`（删 Cookie）
  // 也匹配 maxAge 正则，2026-11 实测在管理页登出逻辑上误报为「HSTS 有效期 0」。
  if (!HSTS_CONFIGURED_RE.test(line)) return false;
  const match = HSTS_MAX_AGE_RE.exec(line);
  if (!match) return false;
  const seconds = Number(match[1] ?? match[2]);
  return Number.isFinite(seconds) && seconds < HSTS_MIN_MAX_AGE;
}

/** 安全头类证据：CSP / HSTS / X-Frame-Options / helmet 装配 */
function classifyHeaderLine(line: string, hit: SourceHit, evidence: SourceEvidence): void {
  if (HELMET_CALL_RE.test(line)) evidence.helmetCall.push(hit);
  if (CSP_DISABLED_RE.test(line)) evidence.cspDisabled.push(hit);
  else if (CSP_CONFIGURED_RE.test(line)) evidence.cspConfigured.push(hit);
  if (HSTS_DISABLED_RE.test(line)) evidence.hstsDisabled.push(hit);
  else if (HSTS_CONFIGURED_RE.test(line)) evidence.hstsConfigured.push(hit);
  if (isWeakHsts(line)) evidence.hstsWeak.push(hit);
  if (FRAME_DISABLED_RE.test(line)) evidence.frameDisabled.push(hit);
  else if (FRAME_CONFIGURED_RE.test(line)) evidence.frameConfigured.push(hit);
}

/** 认证/会话类证据：Cookie 属性 / 令牌有效期 / 密码哈希 / 密钥材料使用 */
function classifyAuthLine(line: string, hit: SourceHit, evidence: SourceEvidence): void {
  if (COOKIE_HTTP_ONLY_RE.test(line)) evidence.cookieHttpOnly.push(hit);
  if (COOKIE_SECURE_RE.test(line)) evidence.cookieSecure.push(hit);
  if (COOKIE_SAME_SITE_RE.test(line)) evidence.cookieSameSite.push(hit);
  if (TOKEN_EXPIRY_RE.test(line)) evidence.tokenExpiry.push(hit);
  if (PASSWORD_HASHING_RE.test(line)) evidence.passwordHashing.push(hit);
  if (CRYPTO_USAGE_RE.test(line)) evidence.cryptoUsage.push(hit);
}

/** 审计 / 密钥生命周期 / 供应链签名证据 */
function classifyGovernanceLine(line: string, hit: SourceHit, evidence: SourceEvidence): void {
  if (AUDIT_LOG_RE.test(line)) evidence.auditLog.push(hit);
  if (KEY_ROTATION_RE.test(line)) evidence.keyRotation.push(hit);
  if (KEY_MANAGEMENT_RE.test(line)) evidence.keyManagement.push(hit);
  if (SIGNATURE_VERIFICATION_RE.test(line)) evidence.signatureVerification.push(hit);
}

/** 单行 → 各证据桶（前缀过滤后逐条判定，命中即入桶） */
function classifyConfigLine(line: string, hit: SourceHit, evidence: SourceEvidence): void {
  classifyHeaderLine(line, hit, evidence);
  classifyAuthLine(line, hit, evidence);
  classifyGovernanceLine(line, hit, evidence);
}

/**
 * 源码证据扫描：CSRF / env 出站 / TLS / 安全头 / 会话 / 审计 / 密钥 / 签名。
 *
 * 纯文件读取，不依赖引擎实例状态；`.github/workflows` 里的 CI 命令另走
 * scanWorkflowEvidence（yml 不属于源码扩展名）。
 */
export function scanSourceEvidence(target: string): SourceEvidence {
  const evidence: SourceEvidence = {
    csrfToken: [],
    sameSite: [],
    originCheck: [],
    outboundValue: [],
    tlsVerifyDisabled: [],
    weakTlsProtocol: [],
    helmetCall: [],
    cspDisabled: [],
    cspConfigured: [],
    hstsDisabled: [],
    hstsConfigured: [],
    hstsWeak: [],
    frameDisabled: [],
    frameConfigured: [],
    cookieHttpOnly: [],
    cookieSecure: [],
    cookieSameSite: [],
    tokenExpiry: [],
    passwordHashing: [],
    cryptoUsage: [],
    auditLog: [],
    keyRotation: [],
    keyManagement: [],
    signatureVerification: [],
  };
  const files: string[] = [];
  walkFiles(target, 0, files, SOURCE_EXTS);
  for (const file of files) {
    if (SELF_BASENAMES.has(path.basename(file, path.extname(file)))) continue;
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
      const hit = hitOf(rel, idx + 1, trim);
      // 出站请求携带 env 值（fetch/axios/curl/http 命中且行内含 process.env / import.meta.env）
      if (OUTBOUND_RE.test(line) && ENV_ACCESS_RE.test(line)) evidence.outboundValue.push(hit);
      if (CSRF_TOKEN_USAGE_RE.test(line)) evidence.csrfToken.push({ ...hit });
      if (SAME_SITE_RE.test(line)) evidence.sameSite.push({ ...hit });
      if (ORIGIN_CHECK_RE.test(line)) evidence.originCheck.push({ ...hit });
      if (TLS_INTEREST_RE.test(line)) {
        if (TLS_VERIFY_DISABLED_RE.test(line)) evidence.tlsVerifyDisabled.push({ ...hit });
        if (WEAK_TLS_PROTOCOL_RE.test(line)) evidence.weakTlsProtocol.push({ ...hit });
      }
      if (CONFIG_INTEREST_RE.test(line)) classifyConfigLine(line, hit, evidence);
    });
  }
  evidence.signatureVerification.push(...scanWorkflowEvidence(target));
  return evidence;
}

/** `.github/workflows` 下的签名/来源校验命令（yml 不在源码扩展名内，单独扫） */
function scanWorkflowEvidence(target: string): SourceHit[] {
  const dir = path.join(target, '.github', 'workflows');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hits: SourceHit[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
    } catch {
      continue;
    }
    const rel = path.relative(target, path.join(dir, entry.name));
    content.split('\n').forEach((line, idx) => {
      if (SIGNATURE_VERIFICATION_RE.test(line)) {
        hits.push(hitOf(rel, idx + 1, line.trim()));
      }
    });
  }
  return hits;
}

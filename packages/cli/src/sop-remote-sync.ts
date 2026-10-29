import * as fs from 'node:fs';
import * as path from 'node:path';
import { SopSyncClient, SopSignatureVerifier, VerifiedSopSyncClient, readRuleSemantics } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';

/**
 * 云端规则同步执行器：版本探测 → 全量下载 → 验签 → 原子落盘。
 *
 * 存在的理由：`guard.block.official.*`（health-score / test-coverage）这类阻断型门禁
 * **只在云端下发**，内置模板里没有。桌面端靠 `sop-cache` 拿到它们，而 CI runner
 * 上从来没有过桌面端 ⇒ 门禁段恒 `total=0`。此前只能靠「CI 里放一份仓库内规则快照」
 * 兜底，那是第二真源，必然漂移 —— 所以做成**运行时向云端取**。
 *
 * 三条硬约束（每条都对应一种曾经踩过或差点踩到的失真）：
 *
 *  1. **不落半份规则集**。规则目录整体替换（临时目录写好再换名），不是逐文件覆盖。
 *     逐文件覆盖时进程被杀 = 新旧规则混装，而门禁会拿这份混装集照常判出「通过」。
 *  2. **空包不覆盖缓存**。云端返回 0 条（服务端 DB 空 / 权限不足只回空数组）时若照样
 *     写盘，就等于用「什么都没查」替换掉一份好规则 —— 然后门禁从「未判定」变成
 *     「规则集无门禁」的合法态，安静程度更上一层。
 *  3. **验签失败即拒收，且不写盘**。规则内容足以决定一次 CI 阻断，未验签的包
 *     与「任意可达网络的中转伪造的包」不可区分。
 */

/** 同步失败的阶段归因（决定用户该看哪里） */
export type SopSyncStage = 'public-key' | 'version' | 'download' | 'verify' | 'write' | 'empty';

export interface SopSyncFailure {
  readonly ok: false;
  readonly stage: SopSyncStage;
  readonly reason: string;
  /** 补充细节：HTTP 状态、超时上限、解析异常等 */
  readonly detail?: string;
}

export interface SopSyncSuccess {
  readonly ok: true;
  readonly version: string;
  readonly ruleCount: number;
  /** 落盘后才算出来的门禁规则条数 —— 0 表示同步成功但本次规则集没有门禁 */
  readonly gateCount: number;
  readonly domains: readonly string[];
  readonly dir: string;
  /** 是否走了验签（false = allowUnsigned 放行，输出里必须显式说明） */
  readonly signed: boolean;
}

export type SopSyncResult = SopSyncSuccess | SopSyncFailure;

/** 同步请求：只含已解析好的参数，不再读环境（便于用例直连本地假服务端） */
export interface SopSyncRequest {
  readonly sopBase: string;
  readonly targetDir: string;
  readonly token?: string;
  /** 已解析的 PEM 公钥；undefined 时按策略去服务端取或直接拒收 */
  readonly publicKey?: string;
  readonly allowUnsigned: boolean;
  readonly now?: Date;
}

/** 落盘的同步元信息（`{dir}/sync-meta.json`）：让人能回答「这份规则是哪次拉下来的」 */
export interface SopSyncMeta {
  readonly version: string;
  readonly syncedAt: string;
  readonly ruleCount: number;
  readonly gateCount: number;
  readonly signed: boolean;
  readonly sopBase: string;
  readonly domains: readonly string[];
}

/** 同步落盘的文件名与目录名（与桌面端 sop-cache 布局一致，扫描引擎原样能读） */
const MODULES_DIR = 'modules';
const META_FILE = 'sync-meta.json';
const RULE_FILE_EXT = '.db';
/** 域名白名单：来自网络的字符串要当文件名用，只允许小写字母/数字/连字符 */
const SAFE_DOMAIN_RE = /^[a-z][a-z0-9-]*$/;

/** 执行同步。任何失败都以 SopSyncResult 返回，**不抛**（调用方按 stage 决定退出码与话术） */
export async function syncRulesFromCloud(req: SopSyncRequest): Promise<SopSyncResult> {
  const key = await resolveVerificationKey(req);
  if ('failure' in key) return key.failure;

  const client = createClient(req, key.key);
  const version = await client.checkRemoteVersion();
  if (!version.ok) {
    return {
      ok: false,
      stage: 'version',
      reason: `云端版本探测失败：${describeKind(version.failure.kind)}`,
      detail: `${version.failure.url} — ${version.failure.detail}`,
    };
  }

  const full = await client.fetchFull(version.data.version);
  if (!full.ok) {
    const rejected = full.failure.kind === 'signature_rejected';
    return {
      ok: false,
      stage: rejected ? 'verify' : 'download',
      reason: rejected
        ? describeKind(full.failure.kind)
        : `规则包下载失败：${describeKind(full.failure.kind)}`,
      detail: `${full.failure.url} — ${full.failure.detail}`,
    };
  }
  if (full.data.length === 0) {
    return {
      ok: false,
      stage: 'empty',
      reason: `云端版本 ${version.data.version} 返回 0 条规则 — 拒绝用空规则集覆盖本地缓存`,
      detail: '服务端规则库为空或权限不足只回了空数组；保留既有缓存不动',
    };
  }

  return persistRules(full.data, {
    version: version.data.version,
    sopBase: req.sopBase,
    targetDir: req.targetDir,
    signed: key.signed,
    now: req.now ?? new Date(),
  });
}

/** 验签公钥的解析结果：拿到了，或者一条明确的失败 */
type KeyResolution = { key?: string; signed: boolean } | { failure: SopSyncFailure };

/**
 * 解析验签公钥。
 *
 * 严格模式（未开 allowUnsigned）下拿不到公钥 ⇒ **直接失败**，不去下载：
 * 下载完再拒收会白花几十秒（冷启动 + brotli 全量包），而且日志里只会留下
 * 一句「验签失败」，掩盖真正的起因是「公钥没配」。
 */
async function resolveVerificationKey(req: SopSyncRequest): Promise<KeyResolution> {
  if (req.publicKey) return { key: req.publicKey, signed: true };
  if (req.allowUnsigned) return { signed: false };

  const fetched = await fetchServerPublicKey(req);
  if (fetched.key) return { key: fetched.key, signed: true };
  return {
    failure: {
      ok: false,
      stage: 'public-key',
      reason: '拿不到验签公钥，拒绝采纳未验签的云端规则（fail-closed）',
      detail:
        `${fetched.detail}。CI 里请设 ZH_SOP_PUBLIC_KEY（PEM 字面量或文件路径）；` +
        '确需内网自建且服务端无签名密钥，才显式设 ZH_SOP_ALLOW_UNSIGNED=1',
    },
  };
}

/** 从服务端取公钥（`GET /sop/public-key`）；失败只回原因，不抛 */
async function fetchServerPublicKey(req: SopSyncRequest): Promise<{ key?: string; detail: string }> {
  const url = `${req.sopBase}/public-key`;
  try {
    const res = await fetch(url, {
      headers: buildHeaders(req.token),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { detail: `${url} 返回 HTTP ${res.status}` };
    const body = (await res.json()) as { publicKey?: unknown };
    const key = typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
    if (!key) return { detail: `${url} 未配置签名公钥（服务端未设 ZH_SOP_PRIVATE_KEY）` };
    return { key, detail: `${url} 公钥可用` };
  } catch (err) {
    return { detail: `${url} 请求失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers['x-api-token'] = token;
  return headers;
}

/** 构造取数客户端：有公钥走验签客户端，无公钥（仅 allowUnsigned）走裸客户端 */
function createClient(
  req: SopSyncRequest,
  publicKey: string | undefined,
): SopSyncClient | VerifiedSopSyncClient {
  if (!publicKey) return new SopSyncClient(req.sopBase, undefined, req.token);
  const verifier = new SopSignatureVerifier(publicKey);
  return new VerifiedSopSyncClient(
    req.sopBase,
    (pkg) => verifier.verifySignature(pkg),
    undefined,
    req.token,
    { requireSigned: !req.allowUnsigned },
  );
}

/** 把失败归因翻成人话（原样打 `http_error` 等于让用户去读源码） */
function describeKind(kind: string): string {
  switch (kind) {
    case 'http_error':
      return '服务端返回非 2xx';
    case 'timeout':
      return '请求超时';
    case 'network_error':
      return '网络不可达';
    case 'decode_error':
      return '响应体解压/解析失败';
    case 'signature_rejected':
      return '验签未通过，已拒收（规则包可能被篡改，或公钥与服务端不匹配）';
    default:
      return kind;
  }
}

interface PersistContext {
  readonly version: string;
  readonly sopBase: string;
  readonly targetDir: string;
  readonly signed: boolean;
  readonly now: Date;
}

/** 按 domain 分组 → 写临时目录 → 整体替换 → 写元信息 */
async function persistRules(rules: readonly SopRule[], ctx: PersistContext): Promise<SopSyncResult> {
  const grouped = groupByDomain(rules);
  const gateCount = rules.filter((rule) => readRuleSemantics(rule) === 'post-scan-gate').length;
  const domains = [...grouped.keys()].sort();

  try {
    await writeModulesAtomically(ctx.targetDir, grouped);
    const meta: SopSyncMeta = {
      version: ctx.version,
      syncedAt: ctx.now.toISOString(),
      ruleCount: rules.length,
      gateCount,
      signed: ctx.signed,
      sopBase: ctx.sopBase,
      domains,
    };
    await writeJsonAtomic(path.join(ctx.targetDir, META_FILE), meta);
  } catch (err) {
    return {
      ok: false,
      stage: 'write',
      reason: `规则写盘失败：${err instanceof Error ? err.message : String(err)}`,
      detail: ctx.targetDir,
    };
  }

  return {
    ok: true,
    version: ctx.version,
    ruleCount: rules.length,
    gateCount,
    domains,
    dir: ctx.targetDir,
    signed: ctx.signed,
  };
}

/**
 * 按 `domain` 分组为 `{domain}.db`（JSON 数组，与桌面端 sop-cache 同格式）。
 *
 * 域名不合法（含 `..`、斜杠、大写）的规则归入 `unknown` 而不是被丢弃 ——
 * 丢弃会让「规则条数对不上」变成一个需要翻源码才能解释的谜。
 */
export function groupByDomain(rules: readonly SopRule[]): Map<string, SopRule[]> {
  const grouped = new Map<string, SopRule[]>();
  for (const rule of rules) {
    const domain = SAFE_DOMAIN_RE.test(rule.domain ?? '') ? rule.domain : 'unknown';
    const bucket = grouped.get(domain);
    if (bucket) bucket.push(rule);
    else grouped.set(domain, [rule]);
  }
  return grouped;
}

/**
 * 原子替换 `{dir}/modules`：先写 `.modules-tmp-<pid>-<ts>`，再 `rm` 旧目录 + `rename`。
 *
 * 不用「逐文件覆盖」的原因见文件头约束 1。rm 与 rename 之间有一个微秒级窗口，
 * 断在这里的后果是缓存目录缺失 ⇒ 下一次扫描明确报「未加载云端规则」并（在
 * require 模式下）退出 2 —— 是**响亮失败**，不是静默通过。
 */
async function writeModulesAtomically(
  targetDir: string,
  grouped: Map<string, SopRule[]>,
): Promise<void> {
  const modulesDir = path.join(targetDir, MODULES_DIR);
  const tmpDir = path.join(targetDir, `.${MODULES_DIR}-tmp-${process.pid}-${Date.now()}`);

  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir, { recursive: true });
  for (const [domain, rules] of grouped) {
    const file = path.join(tmpDir, `${domain}${RULE_FILE_EXT}`);
    await fs.promises.writeFile(file, JSON.stringify(rules, null, 2), 'utf-8');
  }

  await fs.promises.rm(modulesDir, { recursive: true, force: true });
  await fs.promises.rename(tmpDir, modulesDir);
}

/** 写 JSON 文件：先写 `.tmp` 再改名，避免读方看到半截内容 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  await fs.promises.rename(tmp, file);
}

/** 读取同步元信息（不存在 / 损坏 → undefined，不抛） */
export function readSyncMeta(dir: string): SopSyncMeta | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, META_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SopSyncMeta>;
    if (typeof parsed.version !== 'string') return undefined;
    return parsed as SopSyncMeta;
  } catch {
    return undefined;
  }
}

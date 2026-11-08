/**
 * 依赖 CVE 检测（P1-8）：OSV 数据源在线查询。
 *
 * 为什么在 `@zh/pipeline` 而不是某个宿主：CVE 查询是**依赖域**（O10）的检测能力，
 * 桌面端与 CLI 都是它的消费者。实现若留在桌面端，CLI 的 `pipeline --full` 就永远
 * 只能报「未检测」——同一份检测能力出现第二份实现则会撞 jscpd 去重门禁。
 *
 * 设计：
 * - 数据源用 OSV.dev 官方 querybatch API（一次批量查全部 direct 依赖，无需密钥）；
 * - 8s 硬超时 + 全失败降级：不可达 → status='unavailable'，调用方必须显式标注
 *   「漏洞库不可用，本次未检测 CVE」，绝不静默按 0 漏洞处理；
 * - 只查 direct 依赖（批量上限可控，传递依赖数量不受限易打爆请求）；
 * - fetch 经参数注入，单测无需真实网络。
 */

/** OSV querybatch 单查询上限（超出截断；direct 依赖通常远小于此） */
const MAX_QUERIES = 200;
const DEFAULT_OSV_BASE_URL = 'https://api.osv.dev';
const OSV_TIMEOUT_MS = 8_000;
/** OSV base URL 末尾斜杠：模块级复用，避免每次调用重编译 */
const TRAILING_SLASH_RE = /\/+$/;

/**
 * OSV 基地址。`ZH_OSV_BASE_URL` 可覆盖，**只为验收**（指向本地桩或已关闭的端口）。
 *
 * 为什么留这个口子：A15 要求「漏洞库不可达 → 未检测，不进 0 漏洞」，而此前只能在单测里
 * 注入假 fetch 验证——构建产物上没有可复现的断网手段，验收脚本就永远只能跑"在线成功"
 * 那一侧。留环境变量才能在**不拔网线**的前提下跑真实端到端。生产默认值不变。
 */
export function resolveOsvBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ZH_OSV_BASE_URL?.trim();
  if (!raw) return DEFAULT_OSV_BASE_URL;
  return raw.replace(TRAILING_SLASH_RE, '');
}
/**
 * 详情补充拉取上限。querybatch 是**精简响应**（只有 id + modified），
 * 不补详情则 severity 恒落 medium 兜底、summary 为空、CVE 别名缺失。
 * 一次批量 + K 条详情（K = 命中漏洞数）比逐依赖 /v1/query 省得多；
 * 上限只为防止极端项目把请求数打爆（超出部分保留精简数据，不丢漏洞）。
 */
const MAX_DETAIL_FETCHES = 30;
const OSV_DETAIL_URL = (base: string, id: string): string =>
  `${base}/v1/vulns/${encodeURIComponent(id)}`;

/** 单条依赖漏洞发现（OSV 命中结果，供 dashboard 展示） */
export interface CveFinding {
  name: string;
  version: string;
  /** 漏洞标识（GHSA/CVE 别名），多条以「, 」连接 */
  ids: string;
  summary: string;
  severity: 'critical' | 'high' | 'medium';
}

/** 依赖 CVE 检查结果（runCveChecks 的返回形状） */
export interface CveCheckResult {
  /** ok = 漏洞库可达并完成查询；unavailable = 离线/不可达（≠ 0 漏洞） */
  status: 'ok' | 'unavailable';
  findings: CveFinding[];
  /** status='unavailable' 时的原因 */
  reason?: string;
  checkedAt: string;
}

/** 查询输入的最小形状（对齐 @zh/dependency DependencyNode 的子集，便于单测构造） */
export interface CveQueryableDep {
  name: string;
  version: string;
  kind?: string;
}

/** OSV vuln 对象的最小解析形状 */
interface OsvVuln {
  id?: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
}

interface OsvBatchResult {
  results?: Array<{ vulns?: OsvVuln[] } | undefined>;
}

/**
 * 补拉单条漏洞详情（GET /v1/vulns/{id}）。
 * 失败/超时返回 null —— 调用方保留该条的批量精简数据，绝不因为补详情失败就丢掉漏洞。
 */
async function fetchVulnDetail(
  base: string,
  id: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<OsvVuln | null> {
  try {
    const res = await fetchImpl(OSV_DETAIL_URL(base, id), { signal });
    if (!res.ok) return null;
    const detail = (await res.json()) as OsvVuln;
    return detail?.id ? detail : null;
  } catch {
    return null;
  }
}

/**
 * GHSA 严重度 → 三档映射。无 database_specific（部分 CVE 记录）按 medium 兜底——
 * 宁可高估中危也不能漏报，与「静默 0」是两个方向。
 */
export function mapOsvSeverity(vuln: OsvVuln): 'critical' | 'high' | 'medium' {
  const raw = vuln.database_specific?.severity?.toUpperCase();
  if (raw === 'CRITICAL') return 'critical';
  if (raw === 'HIGH') return 'high';
  return 'medium';
}

/** 漏洞展示标识：别名里的 CVE 优先（用户认知度更高），回退主 id */
export function vulnDisplayIds(vuln: OsvVuln): string {
  const cve = (vuln.aliases ?? []).filter((a) => a.startsWith('CVE-'));
  const ids =
    cve.length > 0 ? [...new Set([vuln.id, ...cve].filter(Boolean))] : [vuln.id ?? 'unknown'];
  return ids.join(', ');
}

/** 去重 direct 依赖（同名同版本多入口只查一次），并截断到批量上限 */
export function collectQueryableDeps(nodes: readonly CveQueryableDep[]): CveQueryableDep[] {
  const seen = new Set<string>();
  const list: CveQueryableDep[] = [];
  for (const node of nodes) {
    if (node.kind === 'transitive') continue;
    if (!node.name || !node.version) continue;
    const key = `${node.name}@${node.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (list.length >= MAX_QUERIES) break;
    list.push({ name: node.name, version: node.version, kind: node.kind });
  }
  return list;
}

function severityCount(findings: readonly CveFinding[]): {
  critical: number;
  high: number;
  medium: number;
} {
  const counts = { critical: 0, high: 0, medium: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** CveCheckResult → dashboard 计数（status='unavailable' 恒 0，调用方必须同时展示降级态） */
export function cveCounts(result: CveCheckResult): {
  critical: number;
  high: number;
  medium: number;
} {
  return result.status === 'ok'
    ? severityCount(result.findings)
    : { critical: 0, high: 0, medium: 0 };
}

/** OSV 单条响应 → findings（单个依赖可能命中多条漏洞） */
export function vulnsToFindings(dep: CveQueryableDep, vulns: readonly OsvVuln[]): CveFinding[] {
  return vulns.map((v) => ({
    name: dep.name,
    version: dep.version,
    ids: vulnDisplayIds(v),
    summary: v.summary ?? '',
    severity: mapOsvSeverity(v),
  }));
}

/**
 * OSV querybatch 批量查询。网络失败 / 非 2xx / 超时 / 响应形状不符 → unavailable（reason 带原因）。
 * @param fetchImpl 网络函数（默认全局 fetch；测试注入假实现）
 */
export async function runCveChecks(
  nodes: readonly CveQueryableDep[],
  fetchImpl: typeof fetch = fetch,
): Promise<CveCheckResult> {
  const checkedAt = new Date().toISOString();
  const deps = collectQueryableDeps(nodes);
  if (deps.length === 0) {
    return { status: 'ok', findings: [], checkedAt };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OSV_TIMEOUT_MS);
  const baseUrl = resolveOsvBaseUrl();
  try {
    const response = await fetchImpl(`${baseUrl}/v1/querybatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        queries: deps.map((dep) => ({
          package: { name: dep.name, ecosystem: 'npm' },
          version: dep.version,
        })),
      }),
    });
    if (!response.ok) {
      return {
        status: 'unavailable',
        findings: [],
        reason: `OSV HTTP ${response.status}`,
        checkedAt,
      };
    }
    const payload = (await response.json()) as OsvBatchResult;
    if (!payload || !Array.isArray(payload.results)) {
      return { status: 'unavailable', findings: [], reason: 'OSV 响应形状不符', checkedAt };
    }
    // 命中逐依赖归组：批量响应只有 id/modified，先记下「哪个依赖命中哪些 id」
    const hits: Array<{ dep: CveQueryableDep; vulns: OsvVuln[] }> = [];
    payload.results.forEach((slot, i) => {
      const dep = deps[i];
      if (!dep || !slot?.vulns?.length) return;
      hits.push({ dep, vulns: slot.vulns.filter((v) => typeof v?.id === 'string') });
    });
    // 详情补拉（限并发=全量 Promise.all，上限 MAX_DETAIL_FETCHES）：
    // 不补则 severity 恒 medium、summary 空、无 CVE 号——实测发现的关键缺口。
    const ids = [...new Set(hits.flatMap((h) => h.vulns.map((v) => v.id as string)))];
    const detailIds = ids.slice(0, MAX_DETAIL_FETCHES);
    const details = await Promise.all(
      detailIds.map((id) => fetchVulnDetail(baseUrl, id, fetchImpl, controller.signal)),
    );
    const byId = new Map<string, OsvVuln>();
    for (const detail of details) {
      if (detail?.id) byId.set(detail.id, detail);
    }
    clearTimeout(timer);
    const findings: CveFinding[] = [];
    for (const hit of hits) {
      const hydrated = hit.vulns.map((v) => (v.id ? (byId.get(v.id) ?? v) : v));
      findings.push(...vulnsToFindings(hit.dep, hydrated));
    }
    return { status: 'ok', findings, checkedAt };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // undici 把真正的原因藏在 cause.code（ECONNREFUSED / ENOTFOUND …）：只报
    // "fetch failed" 对用户毫无信息量，分不清是断网、DNS 还是对端拒绝。
    const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
    const reason = message.includes('abort')
      ? `OSV 请求超时（${OSV_TIMEOUT_MS / 1000}s）`
      : causeCode
        ? `${message}（${causeCode}）`
        : message;
    return { status: 'unavailable', findings: [], reason, checkedAt };
  } finally {
    clearTimeout(timer);
  }
}

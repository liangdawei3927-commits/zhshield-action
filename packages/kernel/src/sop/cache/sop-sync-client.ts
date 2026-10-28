import type { SopVersion, SopDiff, SopRule } from '../_meta/sop-types';
import { SopCompressor, CompressionFormat } from './sop-compressor';

/** API 令牌：固定字符串或懒加载函数（每次请求时求值，兼容令牌文件轮换） */
export type ApiTokenProvider = string | (() => string);

/** fetch 返回的响应类型（不直接依赖全局 `Response` 名，随 node types 版本变动） */
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * 远程取数失败的归因分类。
 *
 * 原实现三个方法一律 `catch { return null }`，把「云脑 500」「令牌过期」
 * 「brotli 包损坏」「fetch 超时」四种性质完全不同的失败压成同一个 null：
 * 上层只能统统报 `network_error`，于是日志与面板里它们长得一模一样，
 * 故障无法收敛，重试策略也无法区分（鉴权失败重试一万次也没用）。
 */
export type SopFetchFailureKind =
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'decode_error'
  | 'signature_rejected';

/** 一次取数失败的完整归因 */
export interface SopFetchFailure {
  kind: SopFetchFailureKind;
  /** 请求地址（令牌走 header 不进 URL，可安全落日志） */
  url: string;
  /** HTTP 状态码，仅 http_error 携带 */
  status?: number;
  /** 人可读细节：超时上限、解析异常消息等 */
  detail: string;
}

/** 取数结果：成功带 data，失败带可判别归因 —— 取代裸 null */
export type SopFetchResult<T> = { ok: true; data: T } | { ok: false; failure: SopFetchFailure };

/** 构造失败结果 */
function fail(
  kind: SopFetchFailureKind,
  url: string,
  detail: string,
  status?: number,
): { ok: false; failure: SopFetchFailure } {
  const failure: SopFetchFailure = { kind, url, detail };
  if (status !== undefined) failure.status = status;
  return { ok: false, failure };
}

/**
 * 判定 fetch 抛错的性质：
 * `AbortSignal.timeout()` 抛的是 name 为 TimeoutError 的 DOMException，
 * 其余（DNS 失败、连接被拒、TLS 握手失败）都属网络层，两者重试策略不同。
 */
function classifyThrown(err: unknown): SopFetchFailureKind {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'network_error';
}

/** 异常信息提取：非 Error 抛出物（字符串、对象）也要能落进 detail */
function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * SopSyncClient — 云端同步客户端（文档 7.4 节）
 *
 * 负责与远程 API 通信：检查版本、下载增量 diff、下载全量规则包。
 * 所有方法返回 `SopFetchResult`，失败必带归因，不再用 null 表达"失败"。
 */
export class SopSyncClient {
  protected readonly compressor: SopCompressor;
  private readonly apiToken?: ApiTokenProvider;

  /** 版本探测要快失败快返回；全量包容忍大包，给足时间 */
  protected static readonly TIMEOUT_VERSION_MS = 10_000;
  protected static readonly TIMEOUT_DIFF_MS = 30_000;
  protected static readonly TIMEOUT_FULL_MS = 60_000;

  constructor(
    private readonly remoteBaseUrl: string,
    compressor?: SopCompressor,
    apiToken?: ApiTokenProvider,
  ) {
    this.compressor = compressor ?? new SopCompressor();
    this.apiToken = apiToken;
  }

  /** 组装请求头；注入 x-api-token 供本地后端 LocalOnlyGuard 鉴权（与工具规则路径一致） */
  protected buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.apiToken !== undefined) {
      const token = typeof this.apiToken === 'function' ? this.apiToken() : this.apiToken;
      if (token) headers['x-api-token'] = token;
    }
    return headers;
  }

  /**
   * 统一请求层：只负责「请求是否发出、是否回 2xx」，把超时 / 网络层 / HTTP 状态
   * 三类失败分开归因，不碰响应体解析。子类复用同一口径。
   */
  protected async request(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<SopFetchResult<FetchResponse>> {
    let res: FetchResponse;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      return fail(classifyThrown(err), url, `${timeoutMs}ms 上限内请求失败: ${describe(err)}`);
    }
    if (!res.ok) {
      const statusText = res.statusText ? ` ${res.statusText}` : '';
      return fail('http_error', url, `HTTP ${res.status}${statusText}`, res.status);
    }
    return { ok: true, data: res };
  }

  /**
   * 读取响应体：连接中途断开、body 被截断在这里暴露，归 decode_error
   * （此时请求已 2xx，问题在传输或内容侧，不是"网络不可达"）。
   */
  protected async readBody<T>(
    url: string,
    stage: string,
    read: () => Promise<T>,
  ): Promise<SopFetchResult<T>> {
    try {
      return { ok: true, data: await read() };
    } catch (err) {
      return fail('decode_error', url, `${stage}失败: ${describe(err)}`);
    }
  }

  /** JSON 解码：解析失败归 decode_error（云端返回 HTML 错误页的典型表现） */
  protected async decodeJson<T>(res: FetchResponse, url: string): Promise<SopFetchResult<T>> {
    return this.readBody<T>(url, 'JSON 解析', async () => (await res.json()) as T);
  }

  /** 解压 + JSON 解码：压缩包损坏与 JSON 非法都归 decode_error，细节里区分阶段 */
  protected async decodeCompressed<T>(
    payload: ArrayBuffer,
    format: CompressionFormat,
    url: string,
  ): Promise<SopFetchResult<T>> {
    return this.readBody<T>(url, `${format} 解压或 JSON 解析`, async () => {
      const decompressed = await this.compressor.decompress(new Uint8Array(payload), format);
      return JSON.parse(new TextDecoder().decode(decompressed)) as T;
    });
  }

  /**
   * 检查云端版本 — GET /api/sop/version
   */
  async checkRemoteVersion(): Promise<SopFetchResult<SopVersion>> {
    const url = `${this.remoteBaseUrl}/version`;
    const res = await this.request(
      url,
      this.buildHeaders({ Accept: 'application/json' }),
      SopSyncClient.TIMEOUT_VERSION_MS,
    );
    if (!res.ok) return res;
    return this.decodeJson<SopVersion>(res.data, url);
  }

  /**
   * 下载增量 diff — GET /api/sop/diff?from={fromVersion}&to={toVersion}
   */
  async fetchDiff(fromVersion: string, toVersion: string): Promise<SopFetchResult<SopDiff>> {
    const url = `${this.remoteBaseUrl}/diff?from=${fromVersion}&to=${toVersion}`;
    const res = await this.request(url, this.buildHeaders(), SopSyncClient.TIMEOUT_DIFF_MS);
    if (!res.ok) return res;

    const contentType = res.data.headers.get('content-type') ?? '';
    if (contentType.includes('application/octet-stream') || contentType.includes('cbor')) {
      const body = await this.readBody(url, '读取压缩响应体', () => res.data.arrayBuffer());
      if (!body.ok) return body;
      return this.decodeCompressed<SopDiff>(body.data, CompressionFormat.Gzip, url);
    }

    return this.decodeJson<SopDiff>(res.data, url);
  }

  /**
   * 下载全量规则包 — GET /api/sop/full/{version}
   * 返回解压后的规则列表；失败带归因
   */
  async fetchFull(version: string): Promise<SopFetchResult<SopRule[]>> {
    const url = `${this.remoteBaseUrl}/full/${version}`;
    const res = await this.request(url, this.buildHeaders(), SopSyncClient.TIMEOUT_FULL_MS);
    if (!res.ok) return res;

    const body = await this.readBody(url, '读取压缩响应体', () => res.data.arrayBuffer());
    if (!body.ok) return body;
    return this.decodeCompressed<SopRule[]>(body.data, CompressionFormat.Brotli, url);
  }
}

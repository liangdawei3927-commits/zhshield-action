const TRAILING_SLASHES = /\/+$/;

/**
 * 智汇大脑 API 基址解析。
 * 优先 ZH_API_BASE，其次 VITE_API_BASE，默认生产域名。
 * 例：http://localhost:3010/api/v1
 */
export function resolveApiBase(override?: string): string {
  const raw =
    override?.trim() ||
    process.env.ZH_API_BASE?.trim() ||
    process.env.VITE_API_BASE?.trim() ||
    'https://api.zhishield.com/api/v1';
  return raw.replace(TRAILING_SLASHES, '');
}

export function resolveSopBase(override?: string): string {
  const base = resolveApiBase(override);
  return base.endsWith('/sop') ? base : `${base}/sop`;
}

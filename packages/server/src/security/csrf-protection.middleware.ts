/**
 * 双提交 Cookie 型 CSRF 防护中间件（P9：csrf token）。
 *
 * 原理：服务端为每个浏览器签发 `zh_csrf` 随机令牌 Cookie；携带管理会话
 * （zh_admin_token）的状态变更请求（POST/PUT/PATCH/DELETE）必须以
 * `x-csrf-token` 请求头或表单 `_csrf` 字段回显同一令牌（double-submit）。
 * 攻击者的跨站页面无法读取该 Cookie（SameSite=Strict），因此无法伪造回显值。
 *
 * 判定规则（逐条降低误伤面）：
 * - 未携带会话 Cookie → 放行。跨站请求不会携带 SameSite=Strict 的会话 Cookie，
 *   此时没有可被冒用的 Cookie 会话；未登录入口（login）需先能建立会话。
 * - 携带自定义 API 凭据头（authorization / x-api-token）→ 放行。自定义头跨源请求
 *   必须先通过 CORS 预检（服务端仅允许本地来源），天然免疫 CSRF。
 * - 其余携带会话 Cookie 的状态变更请求必须回显令牌，否则 403。
 */
import { randomBytes } from 'node:crypto';

export const CSRF_COOKIE = 'zh_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const SESSION_COOKIE = 'zh_admin_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const API_CREDENTIAL_HEADERS = ['authorization', 'x-api-token'];

/** express Request / Response 的最小结构类型（项目不引入 @types/express，与 ResLike 约定一致） */
interface CsrfRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
interface CsrfResponse {
  cookie(name: string, value: string, options?: Record<string, unknown>): unknown;
  status(code: number): { json(body: Record<string, unknown>): unknown };
}
type CsrfNext = (err?: unknown) => void;

/** 从 Cookie 头解析指定名称的原始值（与 admin-auth.guard 的 readCookie 约定一致） */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.length > 0 ? rest.join('=') : undefined;
  }
  return undefined;
}

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function readBodyField(body: unknown, field: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function csrfProtection(req: CsrfRequest, res: CsrfResponse, next: CsrfNext): void {
  const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
  let token = readCookie(cookieHeader, CSRF_COOKIE);
  if (!token) {
    token = randomBytes(32).toString('hex');
    res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'strict', path: '/' });
  }

  if (SAFE_METHODS.has(req.method)) return next();

  if (!readCookie(cookieHeader, SESSION_COOKIE)) return next();

  if (API_CREDENTIAL_HEADERS.some((header) => readHeader(req.headers, header))) return next();

  const echo = readHeader(req.headers, CSRF_HEADER) ?? readBodyField(req.body, '_csrf') ?? '';
  if (echo.length > 0 && echo === token) return next();

  res.status(403).json({ statusCode: 403, message: 'CSRF 令牌校验失败' });
}

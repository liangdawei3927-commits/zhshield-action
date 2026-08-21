import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { resolveLanguage, type LanguageCode } from '@zh/i18n';

/**
 * 从请求头解析客户端语言偏好：
 * 读取 Accept-Language 请求头，经 @zh/i18n 的 resolveLanguage 归一化为受支持的语言代码；
 * 无请求头或语言不受支持时回退默认语言（zh-Hans）。
 */
export function resolveRequestLanguage(
  acceptLanguage: string | string[] | undefined,
): LanguageCode {
  const raw = Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage;
  return resolveLanguage(raw).value;
}

/**
 * 请求级语言装饰器：将当前请求的 Accept-Language 请求头解析为 LanguageCode。
 * 用法：@RequestLocale() locale: LanguageCode
 */
export const RequestLocale = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): LanguageCode => {
    const request = ctx.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
    }>();
    return resolveRequestLanguage(request.headers?.['accept-language']);
  },
);

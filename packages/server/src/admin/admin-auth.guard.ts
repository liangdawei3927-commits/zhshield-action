import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { verifyAdminToken } from './admin-token';

/**
 * AdminAuthGuard — C4 管理接口鉴权（Bearer token 优先，cookie 兜底）
 *
 * 令牌来自环境变量 ZH_ADMIN_TOKEN，每次请求实时读取（支持运行中注入/轮换）。
 * 未配置 → 503（管理接口整体不可用）；配置后校验 Authorization: Bearer <token>
 * 或 zh_admin_token cookie（浏览器 SSR 页面用）。比较统一走 verifyAdminToken。
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  private readonly logger = new Logger(AdminAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.ZH_ADMIN_TOKEN;
    if (!expected) {
      this.logger.warn('ZH_ADMIN_TOKEN 未配置，管理接口不可用');
      throw new ServiceUnavailableException('管理令牌未配置，管理接口不可用（请设置 ZH_ADMIN_TOKEN）');
    }

    const request = context.switchToHttp().getRequest();
    const header = (request.headers['authorization'] as string) ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const cookie = this.readCookie(request.headers['cookie'], 'zh_admin_token');
    const token = bearer || cookie;

    if (!verifyAdminToken(token, expected)) {
      this.logger.warn('管理令牌校验失败（来源：Bearer 或 cookie）');
      throw new UnauthorizedException('无效的管理令牌');
    }
    return true;
  }

  private readCookie(cookieHeader: string | undefined, name: string): string {
    if (!cookieHeader) return '';
    for (const part of cookieHeader.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return decodeURIComponent(rest.join('='));
    }
    return '';
  }
}
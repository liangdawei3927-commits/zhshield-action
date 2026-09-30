import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(PUBLIC_KEY, true);

const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1']);

const IPV4_MAPPED_PREFIX_RE = /^::ffff:/;

const TOKEN_FILE = path.join(os.homedir(), '.zhshield', '.api-token');

function resolveLocalToken(): string {
  try {
    const dir = path.dirname(TOKEN_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(TOKEN_FILE)) {
      return fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    }

    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    return token;
  } catch {
    Logger.warn('[LocalOnlyGuard] Token 文件读写失败，降级为随机 token（重启后失效）', 'Auth');
    return crypto.randomBytes(32).toString('hex');
  }
}

@Injectable()
export class LocalOnlyGuard implements CanActivate {
  private readonly logger = new Logger(LocalOnlyGuard.name);
  private readonly expectedToken: string;

  constructor(private reflector: Reflector) {
    this.expectedToken = resolveLocalToken();
  }

  canActivate(context: ExecutionContext): boolean {
    if (isPublicRequest(this.reflector, context)) return true;

    const request = context.switchToHttp().getRequest();
    const clientIp = request.ip ?? request.socket?.remoteAddress ?? '';
    assertLocalIpAllowed(this.logger, clientIp);

    const token = (request.headers['x-api-token'] as string) ?? '';
    assertValidApiToken(this.logger, token, this.expectedToken);

    return true;
  }
}

function isPublicRequest(reflector: Reflector, context: ExecutionContext): boolean {
  const isPublic = reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
    context.getHandler(),
    context.getClass(),
  ]);
  return isPublic;
}

function assertLocalIpAllowed(logger: Logger, clientIp: string): void {
  if (!isLocalIp(clientIp)) {
    logger.warn(`拒绝非本地请求: ${clientIp}`);
    throw new UnauthorizedException('仅允许本地访问');
  }
}

function assertValidApiToken(logger: Logger, token: string, expectedToken: string): void {
  if (!verifyToken(token, expectedToken)) {
    logger.warn(`无效的 API token: ${token.slice(0, 8)}...`);
    throw new UnauthorizedException('无效的 API token');
  }
}

function isLocalIp(ip: string): boolean {
  const normalized = ip.replace(IPV4_MAPPED_PREFIX_RE, '');
  return LOCAL_IPS.has(ip) || LOCAL_IPS.has(normalized);
}

function verifyToken(token: string, expectedToken: string): boolean {
  if (!token || !expectedToken) return false;

  try {
    const left = crypto.createHash('sha256').update(token).digest();
    const right = crypto.createHash('sha256').update(expectedToken).digest();
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

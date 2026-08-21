import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class SentinelWebhookGuard implements CanActivate {
  private readonly logger = new Logger(SentinelWebhookGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const token = request.headers['x-sentinel-token'] as string | undefined;
    const expected = process.env.SENTINEL_WEBHOOK_TOKEN || '';

    if (!token || !expected) {
      this.logger.warn('Missing or misconfigured webhook token');
      return false;
    }

    try {
      const left = crypto.createHash('sha256').update(token).digest();
      const right = crypto.createHash('sha256').update(expected).digest();
      return crypto.timingSafeEqual(left, right);
    } catch {
      return false;
    }
  }
}

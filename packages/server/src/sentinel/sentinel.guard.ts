import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { constantTimeEqual } from '@zh/shared';

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

    return constantTimeEqual(token, expected);
  }
}

import { constantTimeEqual } from '@zh/shared';
import type { AlertPayload } from './types';
import { EventCenter } from './event-center';

export class AlertHandler {
  private eventCenter: EventCenter;
  private webhookToken: string;

  constructor(eventCenter: EventCenter, webhookToken: string) {
    this.eventCenter = eventCenter;
    this.webhookToken = webhookToken;
  }

  verifyToken(token: string): boolean {
    return constantTimeEqual(token, this.webhookToken);
  }

  handleWebhook(
    token: string,
    payload: AlertPayload,
  ): { accepted: boolean; eventId?: string; reason?: string } {
    const validation = this.validateRequest(token, payload);
    if (!validation.accepted) {
      return { accepted: false, reason: validation.reason };
    }

    const { event, isNew } = this.eventCenter.processAlert(payload);

    if (!isNew) {
      return { accepted: true, eventId: event.id, reason: 'duplicate-alert-counted' };
    }

    return { accepted: true, eventId: event.id };
  }

  private validateRequest(
    token: string,
    payload: AlertPayload,
  ): { accepted: boolean; reason?: string } {
    if (!this.verifyToken(token)) {
      return { accepted: false, reason: 'invalid token' };
    }

    if (!payload.alerts || payload.alerts.length === 0) {
      return { accepted: false, reason: 'no alerts in payload' };
    }

    return { accepted: true };
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { AlertHandler } from '../alert-handler';
import { EventCenter } from '../event-center';
import type { AlertPayload } from '../types';

describe('AlertHandler', () => {
  let ec: EventCenter;
  let handler: AlertHandler;
  const TOKEN = 'test-secret-token-123';

  beforeEach(() => {
    ec = new EventCenter();
    handler = new AlertHandler(ec, TOKEN);
  });

  describe('verifyToken', () => {
    it('should return true for matching token', () => {
      expect(handler.verifyToken(TOKEN)).toBe(true);
    });

    it('should return false for wrong token', () => {
      expect(handler.verifyToken('wrong-token')).toBe(false);
    });

    it('should return false for empty token', () => {
      expect(handler.verifyToken('')).toBe(false);
    });
  });

  describe('handleWebhook', () => {
    it('should reject invalid token', () => {
      const result = handler.handleWebhook('bad-token', { alerts: [] } as unknown as AlertPayload);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('invalid token');
    });

    it('should reject empty alerts', () => {
      const result = handler.handleWebhook(TOKEN, { alerts: [] } as unknown as AlertPayload);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('no alerts in payload');
    });

    it('should accept valid webhook and create event', () => {
      const payload = {
        alerts: [{
          fingerprint: 'fp-webhook-1',
          labels: {
            alertname: 'WebhookAlert',
            service: 'api',
            module: 'gateway',
            severity: 'critical',
            repo: 'proj-1',
          },
          annotations: { summary: 'Webhook test alert' },
        }],
      };
      const result = handler.handleWebhook(TOKEN, payload);
      expect(result.accepted).toBe(true);
      expect(result.eventId).toBeDefined();
    });

    it('should deduplicate alerts via webhook', () => {
      const payload = {
        alerts: [{
          fingerprint: 'fp-dedup-wh',
          labels: {
            alertname: 'DedupWH',
            service: 'api',
            module: 'core',
            severity: 'high',
            repo: 'proj-1',
          },
          annotations: { summary: 'Dedup webhook test' },
        }],
      };
      const first = handler.handleWebhook(TOKEN, payload);
      const second = handler.handleWebhook(TOKEN, payload);
      expect(first.eventId).toBe(second.eventId);
      expect(first.reason).toBeUndefined();
      expect(second.reason).toBe('duplicate-alert-counted');
    });
  });
});

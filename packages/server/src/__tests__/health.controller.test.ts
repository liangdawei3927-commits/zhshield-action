import { describe, it, expect, beforeEach } from 'vitest';
import { HealthController } from '../health.controller';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    controller = new HealthController();
  });

  describe('health()', () => {
    it('should return ok status with timestamp', () => {
      const result = controller.health();
      expect(result.status).toBe('ok');
      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('ready()', () => {
    it('should return ready status', () => {
      const result = controller.ready();
      expect(result.status).toBe('ready');
    });
  });

  describe('live()', () => {
    it('should return alive status', () => {
      const result = controller.live();
      expect(result.status).toBe('alive');
    });
  });
});

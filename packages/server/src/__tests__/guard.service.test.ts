import { describe, it, expect, beforeEach } from 'vitest';
import { GuardService } from '../guard/guard.service';
import type { GuardEngine } from '@zh/guard';

describe('GuardService', () => {
  let service: GuardService;

  beforeEach(() => {
    service = new GuardService();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(service).toBeDefined();
    });

    it('should have an engine', () => {
      const engine = (service as unknown as { engine: GuardEngine }).engine;
      expect(engine).toBeDefined();
    });
  });

  describe('runCheck', () => {
    it('should run a guard check and return a report', async () => {
      const report = await service.runCheck(process.cwd());
      expect(report).toBeDefined();
      expect(report.contractVersion).toBe('p0.v1');
      expect(report.mode).toBe('guard');
      expect(report.summary).toBeDefined();
      expect(typeof report.summary.total).toBe('number');
      expect(typeof report.summary.passed).toBe('number');
      expect(typeof report.summary.failed).toBe('number');
      expect(report.generatedAt).toBeDefined();
    });

    it('should support dryRun mode', async () => {
      const report = await service.runCheck(process.cwd(), { dryRun: true });
      expect(report.dryRun).toBe(true);
      expect(report.ok).toBeNull();
    });

    it('should have results array', async () => {
      const report = await service.runCheck(process.cwd());
      expect(Array.isArray(report.results)).toBe(true);
    });
  });
});

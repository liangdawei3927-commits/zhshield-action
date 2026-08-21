import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import { ToolRuleController } from '../sop/tool-rule.controller';

describe('ToolRuleController', () => {
  let controller: ToolRuleController;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    controller = new ToolRuleController();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getVersion()', () => {
    it('returns version metadata when tool is valid', () => {
      const result = controller.getVersion('semgrep');
      expect(result.toolId).toBe('semgrep');
      expect(result.version).toBe('1.2026.07.31.001');
      expect(result.hash).toBeTruthy();
      expect(result.size).toBeGreaterThan(0);
    });

    it('is case-insensitive when resolving the tool name', () => {
      const result = controller.getVersion('DEP-CRUISER');
      expect(result.toolId).toBe('dep-cruiser');
    });

    it('throws NotFoundException when tool is unknown', () => {
      expect(() => controller.getVersion('nmap')).toThrow(NotFoundException);
    });
  });

  describe('getRules()', () => {
    it('returns non-empty rule files for a known tool', () => {
      const files = controller.getRules('eslint');
      expect(files.length).toBeGreaterThan(0);
      expect(files[0]?.filename).toBe('zhshield-security.cjs');
    });

    it('throws NotFoundException when tool is unknown', () => {
      expect(() => controller.getRules('../etc/passwd')).toThrow(NotFoundException);
    });

    it('logs an observability line containing tool, version and hash', () => {
      controller.getRules('trivy');
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const message = String(debugSpy.mock.calls[0]?.[0]);
      expect(message).toContain('trivy');
      expect(message).toContain('1.2026.07.31.001');
    });
  });

  describe('getEmergency()', () => {
    it('returns rule files for a known tool', () => {
      const files = controller.getEmergency('semgrep');
      expect(files.length).toBeGreaterThan(0);
    });

    it('throws NotFoundException when tool is unknown', () => {
      expect(() => controller.getEmergency('metasploit')).toThrow(NotFoundException);
    });

    it('logs a warning that emergency rules mirror the static pack', () => {
      controller.getEmergency('semgrep');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0]).toLowerCase();
      expect(message).toContain('semgrep');
      expect(message).toContain('emergency');
    });
  });
});

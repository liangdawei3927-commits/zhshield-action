import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Logger, NotFoundException } from '@nestjs/common';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { hashToolRuleFiles } from '@zh/kernel';
import { ToolRuleController } from '../sop/tool-rule.controller';
import { ToolRuleLoader } from '../sop/tool-rule-loader';

// packages/server/src/__tests__ → 仓库根
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const REAL_PACKS_DIR = join(REPO_ROOT, 'packages', 'kernel', 'src', 'sop', 'tool-packs');

function makeController(packsDir: string = REAL_PACKS_DIR): ToolRuleController {
  return new ToolRuleController(new ToolRuleLoader(packsDir));
}

describe('ToolRuleController', () => {
  let controller: ToolRuleController;
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    controller = makeController();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('规则包来源 — 三层架构（tool-packs YAML → ToolRuleLoader → controller）', () => {
    it('default ToolRuleLoader resolves the real kernel tool-packs directory', () => {
      const files = new ToolRuleLoader().loadToolRuleFiles('semgrep');
      expect(files.length).toBeGreaterThan(0);
    });

    it('served download payload equals independent loader output for semgrep', () => {
      const expected = new ToolRuleLoader(REAL_PACKS_DIR).loadToolRuleFiles('semgrep');
      expect(controller.getRules('semgrep')).toEqual(expected);
    });

    it('served payload filenames are POSIX relative paths under the tool dir', () => {
      const files = controller.getRules('eslint');
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) {
        expect(file.filename).not.toContain('\\');
        expect(file.filename).toMatch(/\.(yaml|yml|json|toml)$/);
        expect(file.filename).not.toBe('zhshield-security.cjs');
      }
    });

    it('version endpoint hash matches hashToolRuleFiles over the served payload (client sync invariant)', () => {
      for (const tool of ['semgrep', 'trivy', 'eslint', 'dep-cruiser'] as const) {
        const version = controller.getVersion(tool);
        expect(version.hash).toBe(hashToolRuleFiles(controller.getRules(tool)));
        expect(version.version).toBe(`1.${version.hash.slice(0, 12)}`);
        expect(version.size).toBeGreaterThan(0);
      }
    });
  });

  describe('getVersion()', () => {
    it('returns version metadata when tool is valid', () => {
      const result = controller.getVersion('semgrep');
      expect(result.toolId).toBe('semgrep');
      expect(result.version).toBeTruthy();
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
      expect(files[0]?.filename).toBe('rules/security.yml');
    });

    it('throws NotFoundException when tool is unknown', () => {
      expect(() => controller.getRules('../etc/passwd')).toThrow(NotFoundException);
    });

    it('logs an observability line containing tool, version and hash', () => {
      controller.getRules('trivy');
      expect(debugSpy).toHaveBeenCalledTimes(1);
      const message = String(debugSpy.mock.calls[0]?.[0]);
      expect(message).toContain('trivy');
      expect(message).toContain(controller.getVersion('trivy').version);
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

  describe('pack 目录缺失 — 按 loader 语义优雅降级', () => {
    it('serves an empty pack with self-consistent empty version instead of crashing', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'zh-tool-packs-'));
      const emptyController = makeController(emptyDir);

      const files = emptyController.getRules('semgrep');
      expect(files).toEqual([]);

      const version = emptyController.getVersion('semgrep');
      expect(version.toolId).toBe('semgrep');
      expect(version.hash).toBe(hashToolRuleFiles([]));
      expect(version.version).toBe(`1.${version.hash.slice(0, 12)}`);
      expect(version.size).toBe(Buffer.byteLength(JSON.stringify([]), 'utf-8'));
    });

    it('unknown tools still 404 when the packs dir is missing', () => {
      const emptyDir = mkdtempSync(join(tmpdir(), 'zh-tool-packs-'));
      expect(() => makeController(emptyDir).getRules('nmap')).toThrow(NotFoundException);
    });
  });
});

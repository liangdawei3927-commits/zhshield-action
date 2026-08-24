import { describe, it, expect, vi } from 'vitest';
import { GuardToolAdapterWrapper } from '../guard-tool-adapter';
import type { Adapter, CheckResult } from '../types';
import type { ToolScanOptions } from '@zh/shared';

function makeMockAdapter(resultOverrides: Partial<CheckResult> = {}): Adapter {
  const defaultResult: CheckResult = {
    checkId: 'test-check',
    adapter: 'test-adapter',
    status: 'passed',
    severity: 'info',
    blocking: false,
    message: 'All checks passed',
    ...resultOverrides,
  };

  return {
    run: vi.fn().mockResolvedValue({ raw: 'data' }),
    normalize: vi.fn().mockReturnValue(defaultResult),
  };
}

function makeScanOptions(overrides: Partial<ToolScanOptions> = {}): ToolScanOptions {
  return {
    projectPath: '/tmp/test-project',
    projectId: 'test-project',
    targetFiles: ['src/index.ts'],
    ...overrides,
  };
}

describe('GuardToolAdapterWrapper', () => {
  // ─── meta ──────────────────────────────────────────────

  describe('meta', () => {
    it('should set meta from adapter name', () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('eslint-check', adapter);
      expect(wrapper.meta.id).toBe('eslint-check');
      expect(wrapper.meta.name).toBe('eslint-check');
      expect(wrapper.meta.category).toBe('guard');
      expect(wrapper.meta.priority).toBe('P1');
      expect(wrapper.meta.installMode).toBe('builtin');
    });

    it('should apply meta overrides', () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('sensitive-info', adapter, {
        name: 'Sensitive Info Scanner',
        description: 'Detects secrets in code',
      });
      expect(wrapper.meta.name).toBe('Sensitive Info Scanner');
      expect(wrapper.meta.description).toBe('Detects secrets in code');
    });

    it('should generate default description from adapter name', () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('test-adapter', adapter);
      expect(wrapper.meta.description).toBe('Guard: test-adapter');
    });
  });

  // ─── isAvailable ───────────────────────────────────────

  describe('isAvailable', () => {
    it('should always return true', async () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      expect(await wrapper.isAvailable()).toBe(true);
    });
  });

  // ─── scan ──────────────────────────────────────────────

  describe('scan', () => {
    it('should call adapter.run with projectPath and targetFiles', async () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('eslint-check', adapter);
      const options = makeScanOptions();

      await wrapper.scan(options);

      expect(adapter.run).toHaveBeenCalledWith(
        { projectPath: options.projectPath, targetFiles: options.targetFiles },
        expect.objectContaining({ adapter: 'eslint-check', enabled: true }),
      );
    });

    it('should call adapter.normalize with raw result', async () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      await wrapper.scan(makeScanOptions());

      expect(adapter.normalize).toHaveBeenCalledWith(
        { raw: 'data' },
        {},
        expect.objectContaining({ checkId: expect.any(String) }),
      );
    });

    it('should return ToolResult with status "available" when check passed', async () => {
      const adapter = makeMockAdapter({ status: 'passed', severity: 'info' });
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.status).toBe('available');
      expect(result.issues).toEqual([]);
      expect(result.tool).toBe('test');
    });

    it('should return ToolResult with issues when check failed', async () => {
      const adapter = makeMockAdapter({
        status: 'failed',
        severity: 'error',
        message: 'ESLint error found',
      });
      const wrapper = new GuardToolAdapterWrapper('eslint-check', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.status).toBe('available');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].severity).toBe('error');
      expect(result.issues[0].message).toBe('ESLint error found');
      expect(result.issues[0].source).toBe('guard');
    });

    it('should return ToolResult with status "error" when check errored', async () => {
      const adapter = makeMockAdapter({
        status: 'error',
        severity: 'error',
        message: 'Internal adapter error',
      });
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.status).toBe('error');
      expect(result.error).toBe('Internal adapter error');
      expect(result.issues).toHaveLength(1);
    });

    it('should build CheckConfig with ruleId from config when provided', async () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      await wrapper.scan(makeScanOptions({
        config: { ruleId: 'custom-rule-1', severity: 'warning' },
      }));

      expect(adapter.run).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ checkId: 'custom-rule-1', severity: 'warning' }),
      );
    });

    it('should return error ToolResult when adapter throws', async () => {
      const adapter: Adapter = {
        run: vi.fn().mockRejectedValue(new Error('Adapter crashed')),
        normalize: vi.fn(),
      };
      const wrapper = new GuardToolAdapterWrapper('crasher', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.status).toBe('error');
      expect(result.error).toBe('Adapter crashed');
      expect(result.issues).toEqual([]);
    });

    it('should handle non-Error thrown values gracefully', async () => {
      const adapter: Adapter = {
        run: vi.fn().mockRejectedValue('string error'),
        normalize: vi.fn(),
      };
      const wrapper = new GuardToolAdapterWrapper('crasher', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.status).toBe('error');
      expect(result.error).toBe('Guard adapter failed');
    });

    it('should include metadata with duration in ToolResult', async () => {
      const adapter = makeMockAdapter();
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.metadata).toMatchObject({
        duration: expect.any(Number),
        timestamp: expect.any(Date),
      });
    });

    it('should not create issues for warning status (only failed/error produce issues)', async () => {
      const adapter = makeMockAdapter({
        status: 'warning',
        severity: 'warning',
        message: 'Minor issue',
      });
      const wrapper = new GuardToolAdapterWrapper('test', adapter);
      const result = await wrapper.scan(makeScanOptions());

      expect(result.issues).toEqual([]);
      expect(result.status).toBe('available');
    });
  });
});

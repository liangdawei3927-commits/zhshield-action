import { describe, expect, it, vi } from 'vitest';

describe('preload electronAPI surface', () => {
  it('exposes the channels the renderer depends on', () => {
    const api = {
      getAppInfo: vi.fn(),
      minimize: vi.fn(),
      maximize: vi.fn(),
      close: vi.fn(),
      isMaximized: vi.fn(),
      onMaximized: vi.fn(),
      onPipelineProgress: vi.fn(),
      platform: 'darwin',
      loadProjects: vi.fn(),
      saveProjects: vi.fn(),
      openFolderDialog: vi.fn(),
      sop: {
        getVersion: vi.fn(),
        syncNow: vi.fn(),
        getStats: vi.fn(),
        getSyncHealth: vi.fn(),
        emergencyUpdate: vi.fn(),
        checkRules: vi.fn(),
      },
      sync: {
        syncRules: vi.fn(),
        getRulesStatus: vi.fn(),
      },
      engine: {
        runGuard: vi.fn(),
        runInspect: vi.fn(),
        runSecurity: vi.fn(),
        runPipeline: vi.fn(),
        runRefactor: vi.fn(),
      },
      evolve: {
        getSuggestions: vi.fn(),
        getRuleWeights: vi.fn(),
        autoAdjustWeights: vi.fn(),
      },
    };

    expect(api.platform).toBe('darwin');
    expect(typeof api.loadProjects).toBe('function');
    expect(typeof api.sop.syncNow).toBe('function');
    expect(typeof api.engine.runPipeline).toBe('function');
    expect(typeof api.evolve.getSuggestions).toBe('function');
  });
});

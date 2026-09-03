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
      backup: {
        executeBackup: vi.fn(),
        getRecords: vi.fn(),
        getRecord: vi.fn(),
        deleteRecord: vi.fn(),
        getConfig: vi.fn(),
        saveConfig: vi.fn(),
        authorizeGitHub: vi.fn(),
        openFolder: vi.fn(),
        // 2026-09-03 回归：备份进度/完成/失败/记录更新推送必须暴露给渲染层
        onProgress: vi.fn(),
        onCompleted: vi.fn(),
        onFailed: vi.fn(),
        onRecordsUpdated: vi.fn(),
      },
    };

    expect(api.platform).toBe('darwin');
    expect(typeof api.loadProjects).toBe('function');
    expect(typeof api.sop.syncNow).toBe('function');
    expect(typeof api.engine.runPipeline).toBe('function');
    expect(typeof api.evolve.getSuggestions).toBe('function');
    expect(typeof api.backup.onProgress).toBe('function');
    expect(typeof api.backup.onCompleted).toBe('function');
    expect(typeof api.backup.onFailed).toBe('function');
    expect(typeof api.backup.onRecordsUpdated).toBe('function');
  });
});

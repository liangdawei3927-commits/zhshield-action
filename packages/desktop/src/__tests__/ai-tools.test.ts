import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const { userDataDir, getPathMock, getAppPathMock, handleMock } = vi.hoisted(() => {
  const fsMod = require('node:fs') as typeof import('node:fs');
  const osMod = require('node:os') as typeof import('node:os');
  const pathMod = require('node:path') as typeof import('node:path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'zh-desktop-ai-'));
  return {
    userDataDir: dir,
    getPathMock: vi.fn((name: string) => (name === 'userData' ? dir : '/tmp')),
    getAppPathMock: vi.fn(() => '/app'),
    handleMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getPath: getPathMock, getAppPath: getAppPathMock },
  ipcMain: { handle: handleMock },
}));

import { syncAiIntegrationOnStartup } from '../../electron/ipc/ai-tools';

describe('syncAiIntegrationOnStartup 日志注入防护', () => {
  it('项目路径含换行且写入失败：告警被净化，常量模板', async () => {
    const evilPath = path.join(userDataDir, 'evil\npath');
    fs.writeFileSync(evilPath, 'x'); // 普通文件 → 在其下写 opencode.json 抛 ENOTDIR
    fs.writeFileSync(path.join(userDataDir, 'ai-tool.json'), JSON.stringify({ id: 'opencode', enabled: true }));
    fs.writeFileSync(path.join(userDataDir, 'projects.json'), JSON.stringify([{ name: 'evil', path: evilPath }]));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await syncAiIntegrationOnStartup();

      expect(warnSpy).toHaveBeenCalled();
      const [format, pathArg] = warnSpy.mock.calls[0] as [string, unknown];
      expect(format).toBe('[ai:startup] 集成文件同步失败: %s');
      expect(String(pathArg)).not.toContain('\n');
      expect(String(pathArg)).not.toContain('\r');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
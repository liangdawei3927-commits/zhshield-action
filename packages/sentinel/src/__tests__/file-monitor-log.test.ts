import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    watch: vi.fn(() => {
      throw new Error('boom');
    }),
  };
});

import { FileMonitor, EventCenter } from '../index';

describe('FileMonitor watch 失败日志注入防护', () => {
  it('路径含换行被净化，使用常量模板', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-sentinel-log-'));
    const evilPath = path.join(root, 'evil\npath');
    fs.mkdirSync(evilPath); // 目录存在 → 通过 existsSync，进入 watchPath 触发 mock 抛错

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const monitor = new FileMonitor(new EventCenter());
      monitor.start({ projectId: 'proj-1', watchPaths: [evilPath], intervalMs: 60_000 });

      expect(errorSpy).toHaveBeenCalled();
      const [format, pathArg] = errorSpy.mock.calls[0] as [string, unknown];
      expect(format).toBe('[FileMonitor] Failed to watch %s:');
      expect(String(pathArg)).not.toContain('\n');
      expect(String(pathArg)).not.toContain('\r');
    } finally {
      errorSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { buildZipSnapshot } from '../backup/zip-snapshot';

// 仅 mock rename：其余 fs/promises 方法保持真实实现，避免影响 zip 写入/清理
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn() };
});

const workRoot = path.join(os.tmpdir(), `zhshield-zip-snapshot-${crypto.randomUUID()}`);

beforeAll(async () => {
  await fs.promises.mkdir(workRoot, { recursive: true });
});

afterAll(async () => {
  await fs.promises.rm(workRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(fsp.rename).mockReset();
});

describe('buildZipSnapshot rename EPERM 重试', () => {
  it('rename 首次 EPERM 后重试成功：rename 调用 ≥2 次且最终 zip 存在', async () => {
    const projectDir = path.join(workRoot, 'project');
    const zipPath = path.join(workRoot, 'snapshot.zip');
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(path.join(projectDir, 'a.txt'), 'hello', 'utf-8');

    const realRename = fs.promises.rename.bind(fs.promises);
    let renameCalls = 0;
    vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
      renameCalls++;
      if (renameCalls === 1) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return realRename(from, to);
    });

    const result = await buildZipSnapshot({
      files: [path.join(projectDir, 'a.txt')],
      projectPath: projectDir,
      timestamp: '2026-09-16T00:00:00.000Z',
      zipPath,
    });

    expect(result.backedUp).toBe(1);
    expect(renameCalls).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(fs.existsSync(`${zipPath}.tmp`)).toBe(false);
  });

  it('rename 持续 EPERM：重试耗尽后抛错并清理 .tmp', async () => {
    const projectDir = path.join(workRoot, 'project-fail');
    const zipPath = path.join(workRoot, 'snapshot-fail.zip');
    await fs.promises.mkdir(projectDir, { recursive: true });
    await fs.promises.writeFile(path.join(projectDir, 'a.txt'), 'hello', 'utf-8');

    vi.mocked(fsp.rename).mockImplementation(async () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    });

    await expect(
      buildZipSnapshot({
        files: [path.join(projectDir, 'a.txt')],
        projectPath: projectDir,
        timestamp: '2026-09-16T00:00:00.000Z',
        zipPath,
      }),
    ).rejects.toThrow('EPERM');
    expect(fs.existsSync(zipPath)).toBe(false);
    expect(fs.existsSync(`${zipPath}.tmp`)).toBe(false);
  });
});
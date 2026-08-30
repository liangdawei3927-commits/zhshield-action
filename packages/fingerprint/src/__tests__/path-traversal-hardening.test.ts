// path-traversal-hardening：expandWorkspaceGlobs 对越界 workspace pattern 的防护回归测试。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { expandWorkspaceGlobs } from '../detectors/manifest-detector';

const tmpRoots: string[] = [];

function makeTempRoot(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-pt-hardening-'));
  tmpRoots.push(tmp);
  // 固定在 tmp 下嵌套 2 层再放项目根，保证 `project/../../escape-dir`
  // 仍落在可写的 tmp 子树内——不依赖 os.tmpdir() 的深度（浅 tmpdir 如
  // CI 的 /tmp 下 `../..` 会越过可写根目录导致 mkdir 失败）。
  const root = path.join(tmp, 'outer', 'inner', 'project');
  fs.mkdirSync(path.join(tmp, 'outer', 'inner'), { recursive: true });
  return root;
}

afterAll(() => {
  for (const root of tmpRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('expandWorkspaceGlobs path-traversal hardening', () => {
  it('GIVEN 越界 pattern（../escape-dir）WHEN expandWorkspaceGlobs THEN 逃逸目录不被返回', () => {
    const root = makeTempRoot();
    // 在 projectRoot 之外创建真实目录，确保 existsSync 分支被走到。
    const escapeDir = path.join(root, '..', 'escape-dir');
    fs.mkdirSync(escapeDir, { recursive: true });
    try {
      const dirs = expandWorkspaceGlobs(root, ['../escape-dir']);
      expect(dirs).not.toContain('../escape-dir');
    } finally {
      fs.rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it('GIVEN 越界 pattern（../../escape-dir）WHEN expandWorkspaceGlobs THEN 逃逸目录不被返回', () => {
    const root = makeTempRoot();
    const escapeDir = path.join(root, '..', '..', 'escape-dir');
    fs.mkdirSync(escapeDir, { recursive: true });
    try {
      const dirs = expandWorkspaceGlobs(root, ['../../escape-dir']);
      expect(dirs).not.toContain('../../escape-dir');
    } finally {
      fs.rmSync(escapeDir, { recursive: true, force: true });
    }
  });

  it('GIVEN 界内 pattern（packages/app）WHEN expandWorkspaceGlobs THEN 仍返回该目录', () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    const dirs = expandWorkspaceGlobs(root, ['packages/app']);
    expect(dirs).toEqual(['packages/app']);
  });

  it('GIVEN workspace pattern 指向 projectRoot 外的 symlink WHEN expandWorkspaceGlobs THEN symlink 逃逸被阻断且合法目录仍返回', () => {
    const root = makeTempRoot();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-pt-hardening-outside-'));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.symlinkSync(outsideDir, path.join(root, 'escape-link'));
    try {
      const dirs = expandWorkspaceGlobs(root, ['escape-link', 'packages/app']);
      expect(dirs).not.toContain('escape-link');
      expect(dirs).toContain('packages/app');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

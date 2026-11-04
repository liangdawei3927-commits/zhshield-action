import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listRefactorAutoFixBackups,
  restoreRefactorAutoFix,
} from '../../electron/ipc/refactor-autofix-backup';

/**
 * 自动修复撤销闭环（报告 §5.5 用户侧）：列表来自磁盘 manifest、撤销幂等且带边界校验。
 *
 * 这些用例守的是「用户关掉应用、隔天回来仍能撤销」——撤销入口不能是渲染层内存状态，
 * 必须是磁盘上可枚举的事实；同时 backupDir 来自渲染层，必须 fail-closed 校验，
 * 否则一个笔误就能把任意目录当备份恢复。
 */

function writeManifest(dir: string, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      projectRoot: process.cwd(),
      files: [],
      createdFiles: [],
      ...overrides,
    }),
    'utf-8',
  );
}

describe('listRefactorAutoFixBackups / restoreRefactorAutoFix', () => {
  let root: string;
  let backupsRoot: string;
  let originalContent: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-undo-'));
    backupsRoot = path.join(root, '.zhshield', 'backups');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    originalContent = 'export class Foo {\n  public a = 1;\n}\n';
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), originalContent, 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('列出本项目仍可撤销的备份（新→旧），跳过无清单/别项目/非前缀目录', () => {
    const oldDir = path.join(backupsRoot, 'refactor-autofix-2026-01-01T00-00-00-000Z');
    const newDir = path.join(backupsRoot, 'refactor-autofix-2026-02-02T00-00-00-000Z');
    writeManifest(oldDir, {
      projectRoot: path.resolve(root),
      createdAt: '2026-01-01T00:00:00.000Z',
      files: ['src/a.ts'],
    });
    writeManifest(newDir, {
      projectRoot: path.resolve(root),
      createdAt: '2026-02-02T00:00:00.000Z',
      files: ['src/a.ts', 'src/b.ts'],
    });
    fs.mkdirSync(path.join(backupsRoot, 'refactor-autofix-no-manifest'), { recursive: true });
    writeManifest(path.join(backupsRoot, 'refactor-autofix-foreign'), {
      projectRoot: path.join(root, 'somewhere-else'),
    });
    fs.mkdirSync(path.join(backupsRoot, 'garbage-batch-1'), { recursive: true });

    const list = listRefactorAutoFixBackups(root);

    expect(list.map((e) => path.basename(e.backupDir))).toEqual([
      'refactor-autofix-2026-02-02T00-00-00-000Z',
      'refactor-autofix-2026-01-01T00-00-00-000Z',
    ]);
    expect(list[0]?.fileCount).toBe(2);
    expect(list[0]?.createdAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('撤销：恢复备份内容、删除新建文件、ok/verified 为真', () => {
    const backupDir = path.join(backupsRoot, 'refactor-autofix-2026-03-03T00-00-00-000Z');
    writeManifest(backupDir, {
      projectRoot: path.resolve(root),
      files: ['src/a.ts'],
      createdFiles: [path.join(root, 'src', 'new-file.ts')],
    });
    fs.mkdirSync(path.join(backupDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'src', 'a.ts'), originalContent, 'utf-8');
    // 模拟"修复已应用"：源码被改、且生成了新文件
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'MODIFIED', 'utf-8');
    fs.writeFileSync(path.join(root, 'src', 'new-file.ts'), 'x', 'utf-8');

    const result = restoreRefactorAutoFix(root, backupDir);

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.restoredFiles).toEqual([path.join('src', 'a.ts')]);
    expect(result.removedFiles).toEqual([path.join('src', 'new-file.ts')]);
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe(originalContent);
    expect(fs.existsSync(path.join(root, 'src', 'new-file.ts'))).toBe(false);
  });

  it('清单 projectRoot 与本项目不符 → 拒绝恢复（防跨项目误伤）', () => {
    const backupDir = path.join(backupsRoot, 'refactor-autofix-2026-04-04T00-00-00-000Z');
    writeManifest(backupDir, {
      projectRoot: path.join(root, 'other-project'),
      files: ['src/a.ts'],
    });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'MODIFIED', 'utf-8');

    const result = restoreRefactorAutoFix(root, backupDir);

    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe('MODIFIED');
  });

  it('路径边界 fail-closed：项目外 / 更深层 / 前缀不符 一律拒绝且不动文件', () => {
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'MODIFIED', 'utf-8');
    const outside = path.join(os.tmpdir(), 'refactor-autofix-outside');

    expect(() => restoreRefactorAutoFix(root, outside)).toThrow();
    writeManifest(path.join(backupsRoot, 'refactor-autofix-deep', 'nested'));
    expect(() =>
      restoreRefactorAutoFix(root, path.join(backupsRoot, 'refactor-autofix-deep', 'nested')),
    ).toThrow();
    writeManifest(path.join(backupsRoot, 'wrong-prefix'));
    expect(() => restoreRefactorAutoFix(root, path.join(backupsRoot, 'wrong-prefix'))).toThrow();
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe('MODIFIED');
  });

  it('非字符串入参 → 抛错（渲染层 bug 不该被当成业务结果吞掉）', () => {
    expect(() => restoreRefactorAutoFix('', 'x')).toThrow();
    // @ts-expect-error 故意传错类型：验证运行时防御
    expect(() => restoreRefactorAutoFix(root, null)).toThrow();
  });
});

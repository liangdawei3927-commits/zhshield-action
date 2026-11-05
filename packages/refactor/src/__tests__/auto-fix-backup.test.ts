import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listAutoFixBackups, restoreAutoFixBackup } from '../auto-fix-backup';

/**
 * 自动修复撤销闭环（报告 §5.5 用户侧）：列表来自磁盘 manifest、撤销幂等且带边界校验。
 *
 * 这些用例守的是「用户关掉应用、隔天回来仍能撤销」——撤销入口不能是渲染层内存状态，
 * 必须是磁盘上可枚举的事实；同时 backupDir 来自渲染层（不可信入参），必须 fail-closed，
 * 否则一个笔误就能把任意目录当备份恢复。
 *
 * 放在本包而不是桌面端：备份目录约定由本包生成，也只有本包能正确解读；
 * 桌面端只负责把这里的结果搬过进程边界（见 desktop/electron/ipc/refactor-autofix-backup.ts）。
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

describe('listAutoFixBackups / restoreAutoFixBackup', () => {
  let root: string;
  let backupsRoot: string;
  let originalContent: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'refactor-undo-'));
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
      createdFiles: [path.join(root, 'src', 'new-file.ts')],
    });
    fs.mkdirSync(path.join(backupsRoot, 'refactor-autofix-no-manifest'), { recursive: true });
    writeManifest(path.join(backupsRoot, 'refactor-autofix-foreign'), {
      projectRoot: path.join(root, 'somewhere-else'),
    });
    fs.mkdirSync(path.join(backupsRoot, 'garbage-batch-1'), { recursive: true });

    const list = listAutoFixBackups(root);

    expect(list.map((e) => path.basename(e.backupDir))).toEqual([
      'refactor-autofix-2026-02-02T00-00-00-000Z',
      'refactor-autofix-2026-01-01T00-00-00-000Z',
    ]);
    expect(list[0]?.fileCount).toBe(2);
    expect(list[0]?.createdCount).toBe(1);
    expect(list[0]?.createdAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('备份根不存在 / 入参非法时返回空列表（不抛异常）', () => {
    expect(listAutoFixBackups(root)).toEqual([]);
    expect(listAutoFixBackups('')).toEqual([]);
  });

  it('撤销：恢复备份内容、删除新建文件、ok/verified 为真，并消费掉备份目录', () => {
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

    const result = restoreAutoFixBackup(root, backupDir);

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.restoredFiles).toEqual([path.join('src', 'a.ts')]);
    expect(result.removedFiles).toEqual([path.join('src', 'new-file.ts')]);
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe(originalContent);
    expect(fs.existsSync(path.join(root, 'src', 'new-file.ts'))).toBe(false);

    // 撤销一次 = 这份备份已被用掉：目录删除、列表清空（否则 UI 会一直说"可撤销"）
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(listAutoFixBackups(root)).toEqual([]);
  });

  it('已撤销的备份不能再撤一次（目录已消费 → 清单不可恢复，不误报成功）', () => {
    const backupDir = path.join(backupsRoot, 'refactor-autofix-2026-05-05T00-00-00-000Z');
    writeManifest(backupDir, { projectRoot: path.resolve(root), files: ['src/a.ts'] });
    fs.mkdirSync(path.join(backupDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'src', 'a.ts'), originalContent, 'utf-8');
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'MODIFIED', 'utf-8');

    expect(restoreAutoFixBackup(root, backupDir).ok).toBe(true);
    const again = restoreAutoFixBackup(root, backupDir);

    expect(again.ok).toBe(false);
    expect(again.reason).toBe('backup-manifest-invalid');
    // 文件内容仍是原件（第二次撤销没有把内容倒回去或改坏）
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe(originalContent);
  });

  it('清单 projectRoot 与本项目不符 → 拒绝恢复（防跨项目误伤）且备份不删', () => {
    const backupDir = path.join(backupsRoot, 'refactor-autofix-2026-04-04T00-00-00-000Z');
    writeManifest(backupDir, {
      projectRoot: path.join(root, 'other-project'),
      files: ['src/a.ts'],
    });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'MODIFIED', 'utf-8');

    const result = restoreAutoFixBackup(root, backupDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('backup-manifest-invalid');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe('MODIFIED');
    // 被拒绝的备份必须原样保留：删了它，正当项目里的那份数据就真丢了
    expect(fs.existsSync(backupDir)).toBe(true);
  });

  it('路径边界 fail-closed：项目外 / 更深层 / 前缀不符 一律拒绝且不动文件', () => {
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'MODIFIED', 'utf-8');
    const outsideBackup = path.join(os.tmpdir(), 'refactor-autofix-outside');
    writeManifest(outsideBackup);

    expect(restoreAutoFixBackup(root, outsideBackup).reason).toBe('invalid-backup-params');
    writeManifest(path.join(backupsRoot, 'refactor-autofix-deep', 'nested'));
    expect(
      restoreAutoFixBackup(root, path.join(backupsRoot, 'refactor-autofix-deep', 'nested')).reason,
    ).toBe('invalid-backup-params');
    writeManifest(path.join(backupsRoot, 'wrong-prefix'));
    expect(restoreAutoFixBackup(root, path.join(backupsRoot, 'wrong-prefix')).reason).toBe(
      'invalid-backup-params',
    );
    // 备份根自身不是备份目录
    expect(restoreAutoFixBackup(root, backupsRoot).reason).toBe('invalid-backup-params');
    expect(fs.readFileSync(path.join(root, 'src', 'a.ts'), 'utf-8')).toBe('MODIFIED');
  });

  it('非字符串入参 → 返回 ok=false（不进入恢复流程）', () => {
    expect(restoreAutoFixBackup('', 'x').reason).toBe('invalid-backup-params');
    // @ts-expect-error 故意传错类型：验证运行时防御
    expect(restoreAutoFixBackup(root, null).reason).toBe('invalid-backup-params');
  });
});

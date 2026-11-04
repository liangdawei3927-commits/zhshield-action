import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RefactorEngine } from '../engine';
import {
  atomicWriteFileSync,
  readBackupManifest,
  restoreFromBackup,
  rollbackFixes,
} from '../auto-fix-apply';

/**
 * §5.5「可回滚」不变量：把"一键修复可撤销"从注释承诺固化为**可测断言**。
 *
 * 这些用例的价值不在覆盖率，而在**失败语义**：一键修复直接改写用户源码，
 * 若写了第二个文件才失败却留下第一个文件的改动，"没改坏"就是假的。
 * 判据只有一条 —— 失败后工作区必须与修复前**逐字节一致**。
 *
 * 失败注入一律用**真实 IO 手段**（只读目录 / 目标为目录），不 mock `fs`：
 * ESM 下 `fs` 命名空间不可 spy，而声称"写失败会怎样"的用例如果靠 mock 自己造错误，
 * 测到的是 mock，不是文件系统。
 */

/** 造一个会触发封装性修复的文件（≥4 个 public 字段） */
function intimacyFile(className: string, fields: string[]): string {
  const body = fields.map((f) => `  public ${f}: string = "";`).join('\n');
  return `export class ${className} {\n${body}\n}\n`;
}

describe('自动修复的事务不变量（§5.5）', () => {
  let root: string;
  let fileA: string;
  let lockedDir: string;
  let fileB: string;
  let originalA: string;
  let originalB: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-tx-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // B 放子目录，便于把它所在的目录改成只读来制造"真实写失败"
    lockedDir = path.join(root, 'src', 'z-locked');
    fs.mkdirSync(lockedDir, { recursive: true });
    fileA = path.join(root, 'src', 'a.ts');
    fileB = path.join(lockedDir, 'b.ts');
    originalA = intimacyFile('Alpha', ['a1', 'a2', 'a3', 'a4']);
    originalB = intimacyFile('Beta', ['b1', 'b2', 'b3', 'b4']);
    fs.writeFileSync(fileA, originalA, 'utf-8');
    fs.writeFileSync(fileB, originalB, 'utf-8');
  });

  afterEach(() => {
    // 只读目录必须还原，否则 rmSync 清不掉（真实 IO 手段的代价）
    try {
      fs.chmodSync(lockedDir, 0o755);
    } catch {
      // 目录可能已被删除
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('第二个文件写入失败（只读目录）→ 整体回滚，工作区逐字节复原', async () => {
    fs.chmodSync(lockedDir, 0o555); // 真实 EACCES：无法在该目录创建临时文件

    const result = await new RefactorEngine().applyAutoFixes(root);

    expect(result.applied).toBe(false);
    expect(result.fixed).toBe(0);
    expect(result.errors.join('\n')).toContain('整体回滚');
    // 核心断言：失败后工作区必须与修复前完全一致（a 已写过也要被回滚）
    expect(fs.readFileSync(fileA, 'utf-8')).toBe(originalA);
    expect(fs.readFileSync(fileB, 'utf-8')).toBe(originalB);
  });

  it('成功落盘后可从备份一键恢复（含清单与逐字节校验）', async () => {
    const result = await new RefactorEngine().applyAutoFixes(root);

    expect(result.applied).toBe(true);
    expect(result.backupDir).toBeTruthy();
    expect(fs.readFileSync(fileA, 'utf-8')).toContain('private a1');

    const manifest = readBackupManifest(result.backupDir as string);
    expect(manifest).toBeTruthy();
    expect(manifest?.version).toBe(1);
    expect(manifest?.files).toContain(path.join('src', 'a.ts'));
    expect(manifest?.projectRoot).toBe(path.resolve(root));

    const restore = restoreFromBackup(result.backupDir as string);
    expect(restore.verified).toBe(true);
    expect(restore.restoredFiles).toContain(path.join('src', 'a.ts'));
    expect(fs.readFileSync(fileA, 'utf-8')).toBe(originalA);
    expect(fs.readFileSync(fileB, 'utf-8')).toBe(originalB);
  });

  it('回滚本身写不动 → 抛出而不是静默吞掉（安全网失败必须声张）', () => {
    const backupDir = path.join(root, '.zhshield', 'backups', 'rb');
    fs.mkdirSync(path.join(backupDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'src', 'a.ts'), originalA, 'utf-8');
    // 把目标目录锁死：回滚写回时必然 EACCES
    fs.writeFileSync(fileA, 'MODIFIED', 'utf-8');
    fs.chmodSync(path.join(root, 'src'), 0o555);

    try {
      expect(() => rollbackFixes(root, backupDir, [path.join('src', 'a.ts')], [])).toThrow();
      // 且不能谎报已复原
      expect(fs.readFileSync(fileA, 'utf-8')).toBe('MODIFIED');
    } finally {
      fs.chmodSync(path.join(root, 'src'), 0o755);
    }
  });

  it('恢复时删除本次新建的文件（清单 createdFiles 是唯一权威）', () => {
    const backupDir = path.join(root, '.zhshield', 'backups', 'refactor-autofix-test');
    const created = path.join(root, 'src', 'brand-new.ts');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(created, 'export const x = 1;\n', 'utf-8');
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        projectRoot: path.resolve(root),
        files: [],
        createdFiles: [created],
      }),
      'utf-8',
    );

    const restore = restoreFromBackup(backupDir);

    expect(restore.removedFiles).toEqual([path.join('src', 'brand-new.ts')]);
    expect(fs.existsSync(created)).toBe(false);
  });

  it('无清单（或清单损坏）的备份目录 → 明确报不可恢复，而不是假装成功', () => {
    const backupDir = path.join(root, '.zhshield', 'backups', 'corrupt');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), '{oops', 'utf-8');

    expect(readBackupManifest(backupDir)).toBeNull();
    expect(() => restoreFromBackup(backupDir)).toThrow(/不可恢复/);
  });
});

describe('atomicWriteFileSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rename 失败（目标不可替换）时原文件/原目标保持不变，且不残留临时文件', () => {
    const target = path.join(dir, 'keep.ts');
    fs.writeFileSync(target, 'ORIGINAL', 'utf-8');
    // 真实失败注入：rename 到一个非空目录会得到 ENOTDIR/EISDIR/ENOTEMPTY
    const blocker = path.join(dir, 'blocked');
    fs.mkdirSync(blocker);
    fs.writeFileSync(path.join(blocker, 'x'), 'x', 'utf-8');

    expect(() => atomicWriteFileSync(blocker, 'NEW CONTENT')).toThrow();
    // 关键：绝不出现"半截文件"或"新旧混杂"，也不留下临时文件
    expect(fs.readdirSync(blocker)).toEqual(['x']);
    expect(fs.readFileSync(target, 'utf-8')).toBe('ORIGINAL');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('.zhshield-tmp-'))).toEqual([]);
  });

  it('正常写入：内容完整且不留下临时文件', () => {
    const target = path.join(dir, 'ok.ts');
    atomicWriteFileSync(target, 'FULL CONTENT\n');
    expect(fs.readFileSync(target, 'utf-8')).toBe('FULL CONTENT\n');
    expect(fs.readdirSync(dir)).toEqual(['ok.ts']);
  });
});

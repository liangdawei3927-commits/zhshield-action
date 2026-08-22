import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { LocalBackup } from '../backup/local-backup';
import type {
  LocalBackupFileEntry,
  LocalBackupManifest,
} from '../backup/local-backup';
import type { LocalBackupConfig } from '../backup/types';

function makeConfig(backupDir: string, compress: boolean): LocalBackupConfig {
  return {
    enabled: true,
    backupDir,
    maxBackups: 10,
    excludePatterns: [],
    compress,
  };
}

async function writeProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'console.log("hi");\n', 'utf-8');
  await fs.writeFile(path.join(root, 'docs', 'readme.md'), '# 文档\n内容\n', 'utf-8');
}

async function readManifest(backupDir: string): Promise<LocalBackupManifest> {
  const raw = await fs.readFile(path.join(backupDir, 'BACKUP_MANIFEST.json'), 'utf-8');
  return JSON.parse(raw) as LocalBackupManifest;
}

describe('LocalBackup 归档格式一致性', () => {
  let workRoot: string;
  let projectDir: string;
  let backupRoot: string;

  beforeEach(() => {
    workRoot = path.join(os.tmpdir(), `zhshield-localbackup-${crypto.randomUUID()}`);
    projectDir = path.join(workRoot, 'project');
    backupRoot = path.join(workRoot, 'backups');
    fsSync.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fsSync.rmSync(workRoot, { recursive: true, force: true });
  });

  it('compress=false 创建→列出→还原 往返一致', async () => {
    await writeProject(projectDir);
    const local = new LocalBackup(backupRoot);

    const result = await local.backup(projectDir, makeConfig(backupRoot, false));
    expect(result.success).toBe(true);
    const backupPath = result.backupPath!;
    expect(fsSync.statSync(backupPath).isDirectory()).toBe(true);

    const listed = await local.listBackups(backupRoot);
    expect(listed).toContain(backupPath);

    const targetDir = path.join(workRoot, 'restored-plain');
    const restoreResult = await local.restore(backupPath, targetDir);
    expect(restoreResult.failed).toBe(0);
    expect(restoreResult.problems).toEqual([]);
    expect(restoreResult.restored).toBe(2);
    expect(
      await fs.readFile(path.join(targetDir, 'src', 'index.ts'), 'utf-8'),
    ).toBe('console.log("hi");\n');
    expect(await fs.readFile(path.join(targetDir, 'docs', 'readme.md'), 'utf-8')).toBe('# 文档\n内容\n');

    const manifest = await readManifest(backupPath);
    expect(manifest.files.every((f) => f.compression === 'none')).toBe(true);
    expect(manifest.files.every((f) => f.storedAs === f.relativePath)).toBe(true);
  });

  it('compress=true 创建→列出→还原 往返一致（修复前还原为 0 文件）', async () => {
    await writeProject(projectDir);
    const local = new LocalBackup(backupRoot);

    const result = await local.backup(projectDir, makeConfig(backupRoot, true));
    expect(result.success).toBe(true);
    const backupPath = result.backupPath!;

    // 落盘为 .gz，清单记录 gzip 格式
    const manifest = await readManifest(backupPath);
    expect(manifest.files.length).toBe(2);
    for (const entry of manifest.files) {
      expect(entry.storedAs).toBe(`${entry.relativePath}.gz`);
      expect(entry.compression).toBe('gzip');
      expect(fsSync.existsSync(path.join(backupPath, entry.storedAs!))).toBe(true);
    }

    const listed = await local.listBackups(backupRoot);
    expect(listed).toContain(backupPath);

    const targetDir = path.join(workRoot, 'restored-gz');
    const restoreResult = await local.restore(backupPath, targetDir);
    expect(restoreResult.failed).toBe(0);
    expect(restoreResult.problems).toEqual([]);
    expect(restoreResult.restored).toBe(2);
    expect(
      await fs.readFile(path.join(targetDir, 'src', 'index.ts'), 'utf-8'),
    ).toBe('console.log("hi");\n');
    expect(await fs.readFile(path.join(targetDir, 'docs', 'readme.md'), 'utf-8')).toBe('# 文档\n内容\n');
  });

  it('旧版清单（无格式字段）+ 落盘 .gz 通过魔数嗅探兜底还原', async () => {
    const backupPath = path.join(backupRoot, 'legacy-backup');
    await fs.mkdir(path.join(backupPath, 'src'), { recursive: true });
    const content = 'const legacy = true;\n';
    await fs.writeFile(path.join(backupPath, 'src', 'app.ts.gz'), gzipSync(content, { level: 6 }));

    const legacyEntries: LocalBackupFileEntry[] = [
      { relativePath: 'src/app.ts', hash: 'x', size: content.length, backedUpAt: '2026-08-18T00:00:00.000Z' },
    ];
    const legacyManifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: projectDir,
      lastBackupAt: '2026-08-18T00:00:00.000Z',
      fullBackupAt: '2026-08-18T00:00:00.000Z',
      files: legacyEntries,
    };
    await fs.writeFile(
      path.join(backupPath, 'BACKUP_MANIFEST.json'),
      JSON.stringify(legacyManifest, null, 2),
      'utf-8',
    );

    const local = new LocalBackup(backupRoot);
    const targetDir = path.join(workRoot, 'restored-legacy');
    const restoreResult = await local.restore(backupPath, targetDir);

    expect(restoreResult.restored).toBe(1);
    expect(restoreResult.failed).toBe(0);
    expect(await fs.readFile(path.join(targetDir, 'src', 'app.ts'), 'utf-8')).toBe(content);
  });

  it('清单标记未压缩但内容实为 gzip：明确报错且不产出损坏文件', async () => {
    const backupPath = path.join(backupRoot, 'mismatch-backup');
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(path.join(backupPath, 'a.txt'), gzipSync('secret', { level: 6 }));

    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: projectDir,
      lastBackupAt: '2026-08-18T00:00:00.000Z',
      fullBackupAt: '',
      files: [
        { relativePath: 'a.txt', hash: 'x', size: 6, backedUpAt: '2026-08-18T00:00:00.000Z' },
      ],
    };
    await fs.writeFile(
      path.join(backupPath, 'BACKUP_MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const local = new LocalBackup(backupRoot);
    const targetDir = path.join(workRoot, 'restored-mismatch');
    const restoreResult = await local.restore(backupPath, targetDir);

    expect(restoreResult.restored).toBe(0);
    expect(restoreResult.failed).toBe(1);
    expect(restoreResult.problems[0]).toContain('a.txt');
    expect(restoreResult.problems[0]).toContain('gzip');
    expect(fsSync.existsSync(path.join(targetDir, 'a.txt'))).toBe(false);
  });

  it('清单标记 gzip 但内容缺少魔数：明确报错', async () => {
    const backupPath = path.join(backupRoot, 'badmagic-backup');
    await fs.mkdir(backupPath, { recursive: true });
    await fs.writeFile(path.join(backupPath, 'b.txt.gz'), 'plain text, not gzip');

    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: projectDir,
      lastBackupAt: '2026-08-18T00:00:00.000Z',
      fullBackupAt: '',
      files: [
        {
          relativePath: 'b.txt',
          storedAs: 'b.txt.gz',
          compression: 'gzip',
          hash: 'x',
          size: 20,
          backedUpAt: '2026-08-18T00:00:00.000Z',
        },
      ],
    };
    await fs.writeFile(
      path.join(backupPath, 'BACKUP_MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const local = new LocalBackup(backupRoot);
    const restoreResult = await local.restore(backupPath, path.join(workRoot, 'restored-badmagic'));

    expect(restoreResult.restored).toBe(0);
    expect(restoreResult.failed).toBe(1);
    expect(restoreResult.problems[0]).toContain('魔数');
  });

  it('条目文件缺失且无 .gz 兜底：计入失败并给出原因', async () => {
    const backupPath = path.join(backupRoot, 'missing-backup');
    await fs.mkdir(backupPath, { recursive: true });
    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: projectDir,
      lastBackupAt: '2026-08-18T00:00:00.000Z',
      fullBackupAt: '',
      files: [
        { relativePath: 'gone.txt', hash: 'x', size: 1, backedUpAt: '2026-08-18T00:00:00.000Z' },
      ],
    };
    await fs.writeFile(
      path.join(backupPath, 'BACKUP_MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    const local = new LocalBackup(backupRoot);
    const restoreResult = await local.restore(backupPath, path.join(workRoot, 'restored-missing'));

    expect(restoreResult.restored).toBe(0);
    expect(restoreResult.failed).toBe(1);
    expect(restoreResult.problems[0]).toContain('备份文件缺失');
  });
});

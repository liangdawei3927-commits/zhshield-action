import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { defaultBackupConfig } from '../backup/types';
import { BackupConfigManager } from '../backup/config';
import { sanitizeDirSegment, projectBackupSegment } from '../backup/utils';
import { BackupOrchestrator } from '../backup/orchestrator';
import { LocalBackup } from '../backup/local-backup';
import { openZipArchive } from '../backup/zip-archive';
import type { LocalBackupConfig, LocalBackupSubResult } from '../backup/types';

function pathHash(p: string): string {
  return crypto.createHash('sha1').update(p).digest('hex').slice(0, 8);
}

describe('sanitizeDirSegment', () => {
  it('替换路径分隔符与文件系统保留字符', () => {
    expect(sanitizeDirSegment('my app:v1?')).toBe('my-app-v1');
    expect(sanitizeDirSegment('a/b\\c*d')).toBe('a-b-c-d');
  });

  it('去除首尾的点与连字符，空输入回退 project', () => {
    expect(sanitizeDirSegment('...my-app---')).toBe('my-app');
    expect(sanitizeDirSegment('   ')).toBe('project');
  });
});

describe('projectBackupSegment', () => {
  it('无任何项目标识时返回 undefined（回退共享根目录）', () => {
    expect(projectBackupSegment()).toBeUndefined();
    expect(projectBackupSegment('')).toBeUndefined();
    expect(projectBackupSegment('', '  ')).toBeUndefined();
  });

  it('同名不同路径的项目得到不同目录段（防配额互挤的核心保证）', () => {
    const a = projectBackupSegment('/home/u/team/api');
    const b = projectBackupSegment('/home/v/other/api');
    expect(a).toBe(`api-${pathHash('/home/u/team/api')}`);
    expect(b).toBe(`api-${pathHash('/home/v/other/api')}`);
    expect(a).not.toBe(b);
  });

  it('projectName 覆盖可读名，哈希仍取自路径', () => {
    const seg = projectBackupSegment('/x/p', '我的 应用');
    expect(seg).toBe(`我的-应用-${pathHash('/x/p')}`);
  });

  it('projectName 与路径相同时按无名处理（桌面端 projectId=路径 的约定）', () => {
    const seg = projectBackupSegment('/x/my-app', '/x/my-app');
    expect(seg).toBe(`my-app-${pathHash('/x/my-app')}`);
  });
});

describe('defaultBackupConfig 项目隔离默认值', () => {
  it('无身份时保持旧版共享根目录', () => {
    expect(defaultBackupConfig().local.backupDir).toBe('~/zhshield-backups');
  });

  it('有项目路径时默认隔离到 ~/zhshield-backups/<segment>', () => {
    const cfg = defaultBackupConfig({ projectPath: '/home/u/my-app' });
    expect(cfg.local.backupDir).toBe(`~/zhshield-backups/my-app-${pathHash('/home/u/my-app')}`);
  });

  it('默认快照格式为 zip', () => {
    expect(defaultBackupConfig().local.format).toBe('zip');
  });

  it('projectId 可作为 projectPath 的回退标识', () => {
    const cfg = defaultBackupConfig({ projectId: 'proj-abc' });
    expect(cfg.local.backupDir).toBe(`~/zhshield-backups/proj-abc-${pathHash('proj-abc')}`);
  });
});

describe('BackupConfigManager.loadProjectConfig 隔离与显式配置优先级', () => {
  let workRoot: string;
  let projectDir: string;
  let manager: BackupConfigManager;

  beforeEach(() => {
    workRoot = path.join(os.tmpdir(), `zhshield-backupcfg-${crypto.randomUUID()}`);
    projectDir = path.join(workRoot, 'proj-a');
    fsSync.mkdirSync(projectDir, { recursive: true });
    manager = new BackupConfigManager();
  });

  afterEach(() => {
    fsSync.rmSync(workRoot, { recursive: true, force: true });
  });

  it('项目未配置 yml 时返回隔离默认目录', async () => {
    const cfg = await manager.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe(`~/zhshield-backups/proj-a-${pathHash(projectDir)}`);
  });

  it('yml 显式 backupDir 优先于隔离默认值', async () => {
    const zhDir = path.join(projectDir, '.zhshield');
    await fs.mkdir(zhDir, { recursive: true });
    await fs.writeFile(
      path.join(zhDir, 'backup.yml'),
      ['backup:', '  local:', '    backupDir: ~/custom-backups', '    maxBackups: 3'].join('\n'),
      'utf-8',
    );
    const cfg = await manager.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe('~/custom-backups');
    expect(cfg.local.maxBackups).toBe(3);
    expect(cfg.local.enabled).toBe(true);
  });

  it('projectName 影响可读名但不影响哈希', async () => {
    const cfg = await manager.loadProjectConfig(projectDir, '自定义 名');
    expect(cfg.local.backupDir).toBe(`~/zhshield-backups/自定义-名-${pathHash(projectDir)}`);
  });

  it('format 字段随 yml 读写往返保留', async () => {
    const zhDir = path.join(projectDir, '.zhshield');
    await fs.mkdir(zhDir, { recursive: true });
    await fs.writeFile(
      path.join(zhDir, 'backup.yml'),
      ['backup:', '  local:', '    format: directory'].join('\n'),
      'utf-8',
    );
    const cfg = await manager.loadProjectConfig(projectDir);
    expect(cfg.local.format).toBe('directory');

    await manager.saveProjectConfig(projectDir, cfg);
    const reloaded = await manager.loadProjectConfig(projectDir);
    expect(reloaded.local.format).toBe('directory');
  });

  it('schedule 的 dayOfWeek/dayOfMonth 读写往返保留（回归：序列化曾丢弃该字段）', async () => {
    const cfg = await manager.loadProjectConfig(projectDir);
    await manager.saveProjectConfig(projectDir, {
      ...cfg,
      schedule: {
        ...cfg.schedule,
        enabled: true,
        frequency: 'weekly',
        time: '09:30',
        dayOfWeek: 3,
      },
    });

    const yml = await fs.readFile(path.join(projectDir, '.zhshield', 'backup.yml'), 'utf-8');
    expect(yml).toContain('dayOfWeek: 3');

    const reloaded = await manager.loadProjectConfig(projectDir);
    expect(reloaded.schedule.enabled).toBe(true);
    expect(reloaded.schedule.frequency).toBe('weekly');
    expect(reloaded.schedule.time).toBe('09:30');
    expect(reloaded.schedule.dayOfWeek).toBe(3);
  });
});

describe('BackupOrchestrator 接线与真实落盘（端到端）', () => {
  let workRoot: string;
  let projectDir: string;
  let backupRoot: string;
  let manager: BackupConfigManager;

  beforeEach(async () => {
    workRoot = path.join(os.tmpdir(), `zhshield-e2e-${crypto.randomUUID()}`);
    projectDir = path.join(workRoot, 'proj-a');
    backupRoot = path.join(workRoot, 'backups');
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
    const zhDir = path.join(projectDir, '.zhshield');
    await fs.mkdir(zhDir, { recursive: true });
    await fs.writeFile(
      path.join(zhDir, 'backup.yml'),
      [
        'backup:',
        '  local:',
        `    backupDir: ${backupRoot}`,
        '    maxBackups: 3',
        '    format: directory',
      ].join('\n'),
      'utf-8',
    );
    manager = new BackupConfigManager();
  });

  afterEach(() => {
    fsSync.rmSync(workRoot, { recursive: true, force: true });
  });

  function buildOrchestrator(): BackupOrchestrator {
    return new BackupOrchestrator({
      configManager: manager,
      localBackup: new LocalBackup(backupRoot),
    });
  }

  it('显式 projectName 透传配置层，目录模式快照落盘（legacy 回归）', async () => {
    const spy = vi.spyOn(manager, 'loadProjectConfig');
    const result = await buildOrchestrator().execute({
      projectId: projectDir,
      projectPath: projectDir,
      projectName: '项目 甲',
      trigger: 'manual',
    });

    expect(spy).toHaveBeenCalledWith(projectDir, '项目 甲');
    expect(result.overallStatus).toBe('success');

    const local = result.results.find((r): r is LocalBackupSubResult => r.type === 'local');
    expect(local?.success).toBe(true);
    expect(local?.backupPath?.startsWith(backupRoot)).toBe(true);
    expect(local?.fileCount).toBeGreaterThan(0);

    const manifest = JSON.parse(
      await fs.readFile(path.join(local!.backupPath!, 'BACKUP_MANIFEST.json'), 'utf-8'),
    ) as { files: Array<{ relativePath: string }> };
    expect(manifest.files.some((f) => f.relativePath === path.join('src', 'index.ts'))).toBe(true);
  });

  it('未提供 projectName 时以 undefined 透传（还原接线即此用例失败）', async () => {
    const spy = vi.spyOn(manager, 'loadProjectConfig');
    const result = await buildOrchestrator().execute({
      projectId: projectDir,
      projectPath: projectDir,
      trigger: 'manual',
    });

    expect(spy).toHaveBeenCalledWith(projectDir, undefined);
    expect(result.overallStatus).toBe('success');
  });
});

describe('LocalBackup zip 归档（默认格式）', () => {
  let workRoot: string;
  let projectDir: string;
  let backupRoot: string;

  beforeEach(async () => {
    workRoot = path.join(os.tmpdir(), `zhshield-zip-${crypto.randomUUID()}`);
    projectDir = path.join(workRoot, 'proj-a');
    backupRoot = path.join(workRoot, 'backups');
    await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectDir, 'src', 'index.ts'), 'export const a = 1;\n', 'utf-8');
    await fs.writeFile(path.join(projectDir, 'README.md'), '# demo\n', 'utf-8');
  });

  afterEach(() => {
    fsSync.rmSync(workRoot, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<LocalBackupConfig>): LocalBackupConfig {
    return {
      ...defaultBackupConfig({ projectPath: projectDir }).local,
      backupDir: backupRoot,
      ...overrides,
    };
  }

  it('备份产出单文件归档，清单作为包内条目', async () => {
    const lb = new LocalBackup(backupRoot);
    const result = await lb.backup(projectDir, makeConfig());

    expect(result.success).toBe(true);
    expect(result.backupPath?.endsWith('.zip')).toBe(true);
    expect(fsSync.existsSync(result.backupPath!)).toBe(true);

    const archive = await openZipArchive(result.backupPath!);
    try {
      expect(archive.entriesByName.has('BACKUP_MANIFEST.json')).toBe(true);
      expect(archive.entriesByName.has('src/index.ts')).toBe(true);
      expect(archive.entriesByName.has('README.md')).toBe(true);
      const manifestBuf = await archive.readEntry(
        archive.entriesByName.get('BACKUP_MANIFEST.json')!,
      );
      const manifest = JSON.parse(manifestBuf.toString('utf-8')) as {
        files: Array<{ relativePath: string }>;
      };
      expect(manifest.files).toHaveLength(2);
    } finally {
      archive.close();
    }
  });

  it('从 zip 归档还原出完整项目文件', async () => {
    const lb = new LocalBackup(backupRoot);
    const result = await lb.backup(projectDir, makeConfig());
    const restoreDir = path.join(workRoot, 'restored');

    const restored = await lb.restore(result.backupPath!, restoreDir);

    expect(restored.failed).toBe(0);
    expect(restored.restored).toBe(2);
    expect(await fs.readFile(path.join(restoreDir, 'src', 'index.ts'), 'utf-8')).toBe(
      'export const a = 1;\n',
    );
    expect(await fs.readFile(path.join(restoreDir, 'README.md'), 'utf-8')).toBe('# demo\n');
  });

  it('轮换兼容目录与 zip 混存，非快照条目不受影响', async () => {
    await fs.mkdir(path.join(backupRoot, '2020-01-01T00-00-00-000Z'), { recursive: true });
    await fs.mkdir(path.join(backupRoot, 'pre-restore-x'), { recursive: true });
    await fs.writeFile(path.join(backupRoot, '2020-01-02T00-00-00-000Z.zip'), 'stale', 'utf-8');

    const lb = new LocalBackup(backupRoot);
    const result = await lb.backup(projectDir, makeConfig({ maxBackups: 2 }));

    expect(result.success).toBe(true);
    expect(fsSync.existsSync(path.join(backupRoot, '2020-01-01T00-00-00-000Z'))).toBe(false);
    expect(fsSync.existsSync(path.join(backupRoot, '2020-01-02T00-00-00-000Z.zip'))).toBe(true);
    expect(fsSync.existsSync(path.join(backupRoot, 'pre-restore-x'))).toBe(true);
  });
});

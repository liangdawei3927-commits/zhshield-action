import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { BackupConfigManager } from '../backup/config';
import { DEFAULT_BACKUP_ROOT } from '../backup/types';

/**
 * 全局默认备份目录的接线（2026-09-17 R9 修复）。
 *
 * 旧行为：defaultBackupDir / getGlobalConfig / saveGlobalConfig 三者齐全，
 * 但 loadProjectConfig 生成默认值时硬编码 ~/zhshield-backups，
 * 从不读全局配置 —— 用户改了备份位置也毫无变化（静默无效）。
 * 本文件锁死优先级：构造注入 > 持久化文件 > 内置默认。
 */

function pathHash(p: string): string {
  return crypto.createHash('sha1').update(p).digest('hex').slice(0, 8);
}

describe('BackupConfigManager 全局默认备份目录', () => {
  let workRoot: string;
  let projectDir: string;
  let globalConfigPath: string;

  beforeEach(() => {
    workRoot = path.join(os.tmpdir(), `zhshield-globaldir-${crypto.randomUUID()}`);
    projectDir = path.join(workRoot, 'proj-a');
    fsSync.mkdirSync(projectDir, { recursive: true });
    globalConfigPath = path.join(workRoot, 'global.json');
  });

  afterEach(() => {
    fsSync.rmSync(workRoot, { recursive: true, force: true });
  });

  it('无全局配置时保持旧版默认（~/zhshield-backups/<segment>）', async () => {
    const manager = new BackupConfigManager(undefined, { globalConfigPath });
    const cfg = await manager.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe(`${DEFAULT_BACKUP_ROOT}/proj-a-${pathHash(projectDir)}`);
  });

  it('持久化的 defaultBackupDir 真正生效（此前是死配置）', async () => {
    const writer = new BackupConfigManager(undefined, { globalConfigPath });
    await writer.saveGlobalConfig({ defaultBackupDir: '/Volumes/Ext/backups' });

    // 换一个实例：证明生效路径来自落盘文件而非内存
    const reader = new BackupConfigManager(undefined, { globalConfigPath });
    const cfg = await reader.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe(`/Volumes/Ext/backups/proj-a-${pathHash(projectDir)}`);
  });

  it('构造时显式注入优先于持久化文件（程序化覆盖/测试可控）', async () => {
    const writer = new BackupConfigManager(undefined, { globalConfigPath });
    await writer.saveGlobalConfig({ defaultBackupDir: '/Volumes/Ext/backups' });

    const injected = new BackupConfigManager(
      { defaultBackupDir: '~/injected-backups' },
      { globalConfigPath },
    );
    const cfg = await injected.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe(`~/injected-backups/proj-a-${pathHash(projectDir)}`);
  });

  it('saveGlobalConfig 后同实例立即生效', async () => {
    const manager = new BackupConfigManager(undefined, { globalConfigPath });
    await manager.saveGlobalConfig({ defaultBackupDir: '~/moved-backups' });
    const cfg = await manager.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe(`~/moved-backups/proj-a-${pathHash(projectDir)}`);
  });

  it('项目 yml 显式 backupDir 仍高于全局默认', async () => {
    const writer = new BackupConfigManager(undefined, { globalConfigPath });
    await writer.saveGlobalConfig({ defaultBackupDir: '/Volumes/Ext/backups' });

    const zhDir = path.join(projectDir, '.zhshield');
    await fs.promises.mkdir(zhDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(zhDir, 'backup.yml'),
      ['backup:', '  local:', '    backupDir: ~/project-specific'].join('\n'),
      'utf-8',
    );

    const reader = new BackupConfigManager(undefined, { globalConfigPath });
    const cfg = await reader.loadProjectConfig(projectDir);
    expect(cfg.local.backupDir).toBe('~/project-specific');
  });
});

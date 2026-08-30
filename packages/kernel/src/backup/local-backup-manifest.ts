/**
 * 一键备份系统 — 本地备份清单（MANIFEST.json / BACKUP_MANIFEST.json）读写
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LocalBackupFileEntry, LocalBackupManifest } from './local-backup';

export class LocalBackupManifestStore {
  async loadManifest(backupRoot: string): Promise<LocalBackupManifest | null> {
    const manifestPath = path.join(backupRoot, 'MANIFEST.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as LocalBackupManifest;
    } catch {
      return null;
    }
  }

  async readManifest(backupDir: string): Promise<LocalBackupManifest | null> {
    const manifestPath = path.join(backupDir, 'BACKUP_MANIFEST.json');
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as LocalBackupManifest;
    } catch {
      return null;
    }
  }

  async writeManifest(
    backupDir: string,
    timestamp: string,
    isFullBackup: boolean,
    files: LocalBackupFileEntry[],
  ): Promise<void> {
    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: backupDir,
      lastBackupAt: timestamp,
      fullBackupAt: isFullBackup ? timestamp : '',
      files,
    };
    await fs.writeFile(
      path.join(backupDir, 'BACKUP_MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  async updateManifestFile(
    backupRoot: string,
    files: LocalBackupFileEntry[],
    timestamp: string,
    isFullBackup: boolean,
  ): Promise<void> {
    const existing = await this.loadManifest(backupRoot);
    const mergedFiles = isFullBackup ? files : [...(existing?.files ?? []), ...files];
    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: backupRoot,
      lastBackupAt: timestamp,
      fullBackupAt: existing?.fullBackupAt ?? timestamp,
      files: mergedFiles,
    };
    await fs.writeFile(
      path.join(backupRoot, 'MANIFEST.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }
}

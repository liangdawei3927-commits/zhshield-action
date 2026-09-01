/**
 * 一键备份系统 — zip 归档快照的构建与还原
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控；
 * 清单随包携带（BACKUP_MANIFEST.json 条目），恢复时从归档内读取。
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as yazl from 'yazl';
import { safeJoinReal, PathTraversalError } from '@zh/shared';
import { pipeline } from 'node:stream/promises';
import { hashFile } from './utils';
import { openZipArchive, toZipEntryName } from './zip-archive';
import type {
  LocalBackupFileEntry,
  LocalBackupManifest,
  LocalBackupRestoreResult,
} from './local-backup';

export interface ZipSnapshotStats {
  backedUp: number;
  errors: number;
  totalSize: number;
  fileEntries: LocalBackupFileEntry[];
}

export interface ZipSnapshotRequest {
  files: string[];
  projectPath: string;
  timestamp: string;
  zipPath: string;
  abortSignal?: AbortSignal;
}

/**
 * 构建单文件归档快照。
 * 先写 <name>.zip.tmp 再原子改名，避免轮换/打开读到半成品。
 */
export async function buildZipSnapshot(request: ZipSnapshotRequest): Promise<ZipSnapshotStats> {
  const { files, projectPath, timestamp, zipPath, abortSignal } = request;
  const tmpZipPath = `${zipPath}.tmp`;
  const zip = new yazl.ZipFile();

  const { fileEntries, backedUp, errors, totalSize } = await addFilesToZip(
    zip,
    files,
    projectPath,
    timestamp,
    abortSignal,
  );
  await finalizeZip(zip, fileEntries, timestamp, tmpZipPath, zipPath, abortSignal);

  return { backedUp, errors, totalSize, fileEntries };
}

/** 逐个文件写入 zip：计算哈希与大小，记录清单条目 */
async function addFilesToZip(
  zip: yazl.ZipFile,
  files: string[],
  projectPath: string,
  timestamp: string,
  abortSignal?: AbortSignal,
): Promise<{
  fileEntries: LocalBackupFileEntry[];
  backedUp: number;
  errors: number;
  totalSize: number;
}> {
  const fileEntries: LocalBackupFileEntry[] = [];
  let backedUp = 0;
  let errors = 0;
  let totalSize = 0;

  for (const file of files) {
    if (abortSignal?.aborted) break;
    const relativePath = toZipEntryName(file, projectPath);
    try {
      const [hash, stat] = await Promise.all([hashFile(file), fs.stat(file)]);
      zip.addFile(file, relativePath);
      fileEntries.push({
        relativePath,
        hash,
        size: stat.size,
        backedUpAt: timestamp,
        storedAs: relativePath,
        compression: 'none',
      });
      totalSize += stat.size;
      backedUp++;
    } catch {
      errors++;
    }
  }
  return { fileEntries, backedUp, errors, totalSize };
}

/** 写入清单并落盘：先写 .tmp 再原子改名，失败清理临时文件 */
async function finalizeZip(
  zip: yazl.ZipFile,
  fileEntries: LocalBackupFileEntry[],
  timestamp: string,
  tmpZipPath: string,
  zipPath: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: zipPath,
      lastBackupAt: timestamp,
      fullBackupAt: timestamp,
      files: fileEntries,
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'), 'BACKUP_MANIFEST.json');
    zip.end();
    await pipeline(zip.outputStream, fsSync.createWriteStream(tmpZipPath));
    if (abortSignal?.aborted) {
      await fs.rm(tmpZipPath, { force: true }).catch(() => {});
    } else {
      await fs.rename(tmpZipPath, zipPath);
    }
  } catch (err) {
    await fs.rm(tmpZipPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function extractZipEntry(
  archive: Awaited<ReturnType<typeof openZipArchive>>,
  entryName: string,
  targetPath: string,
): Promise<void> {
  const zipEntry = archive.entriesByName.get(entryName);
  if (!zipEntry) throw new Error(`备份文件缺失（期望 ${entryName}）`);
  const stream = await archive.openEntryStream(zipEntry);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await pipeline(stream, fsSync.createWriteStream(targetPath));
}

/** 从 zip 归档还原：清单取自归档内 BACKUP_MANIFEST.json 条目，逐条流式解压 */
export async function restoreFromZipArchive(
  zipPath: string,
  targetDir: string,
  abortSignal?: AbortSignal,
): Promise<LocalBackupRestoreResult> {
  const archive = await openZipArchive(zipPath);
  try {
    const files = await readManifestFiles(archive);
    return await restoreEntries(archive, files, targetDir, abortSignal);
  } finally {
    archive.close();
  }
}

/** 从归档内读取 BACKUP_MANIFEST.json 清单；缺失时按空清单处理 */
async function readManifestFiles(
  archive: Awaited<ReturnType<typeof openZipArchive>>,
): Promise<LocalBackupFileEntry[]> {
  const manifestEntry = archive.entriesByName.get('BACKUP_MANIFEST.json');
  const manifestBuf = manifestEntry ? await archive.readEntry(manifestEntry) : null;
  return manifestBuf
    ? (JSON.parse(manifestBuf.toString('utf-8')) as LocalBackupManifest).files
    : [];
}

/** 解析还原目标路径；路径穿越被拦截时返回 null（调用方计数失败），其他错误原样抛出 */
function resolveRestoreTarget(targetDir: string, relativePath: string): string | null {
  try {
    return safeJoinReal(targetDir, relativePath);
  } catch (err) {
    if (err instanceof PathTraversalError) return null;
    throw err;
  }
}

/** 逐条还原：路径穿越拦截 + 解压失败计数 */
async function restoreEntries(
  archive: Awaited<ReturnType<typeof openZipArchive>>,
  files: LocalBackupFileEntry[],
  targetDir: string,
  abortSignal?: AbortSignal,
): Promise<{ restored: number; failed: number; problems: string[] }> {
  let restored = 0;
  let failed = 0;
  const problems: string[] = [];

  for (const entry of files) {
    if (abortSignal?.aborted) break;
    const targetPath = resolveRestoreTarget(targetDir, entry.relativePath);
    if (targetPath === null) {
      // 防御纵深：即使底层 zip 库未拦截，也绝不写盘到 targetDir 之外
      failed++;
      problems.push(`${entry.relativePath}: path traversal blocked`);
      continue;
    }
    try {
      await extractZipEntry(archive, entry.relativePath, targetPath);
      restored++;
    } catch (err) {
      failed++;
      problems.push(`${entry.relativePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { restored, failed, problems };
}

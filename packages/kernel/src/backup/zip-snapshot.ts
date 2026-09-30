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
import type { LocalBackupFileEntry, LocalBackupManifest, LocalBackupRestoreResult } from './types';

/** zip 快照构建统计：成功/失败文件数、总体积及写入归档的文件条目清单 */
export interface ZipSnapshotStats {
  backedUp: number;
  errors: number;
  totalSize: number;
  fileEntries: LocalBackupFileEntry[];
}

/** 构建 zip 快照的入参：待打包文件列表、项目根路径、归档输出路径与取消信号 */
export interface ZipSnapshotRequest {
  files: string[];
  projectPath: string;
  timestamp: string;
  zipPath: string;
  abortSignal?: AbortSignal;
}

/** addFilesToZip 参数对象 */
interface AddFilesToZipParams {
  zip: yazl.ZipFile;
  files: string[];
  projectPath: string;
  timestamp: string;
  abortSignal?: AbortSignal;
}

/** finalizeZip 参数对象 */
interface FinalizeZipParams {
  zip: yazl.ZipFile;
  fileEntries: LocalBackupFileEntry[];
  timestamp: string;
  tmpZipPath: string;
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

  const { fileEntries, backedUp, errors, totalSize } = await addFilesToZip({
    zip,
    files,
    projectPath,
    timestamp,
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });
  await finalizeZip({
    zip,
    fileEntries,
    timestamp,
    tmpZipPath,
    zipPath,
    ...(abortSignal !== undefined ? { abortSignal } : {}),
  });

  return { backedUp, errors, totalSize, fileEntries };
}

/** 逐个文件写入 zip：计算哈希与大小，记录清单条目 */
async function addFilesToZip(params: AddFilesToZipParams): Promise<{
  fileEntries: LocalBackupFileEntry[];
  backedUp: number;
  errors: number;
  totalSize: number;
}> {
  const { zip, files, projectPath, timestamp, abortSignal } = params;
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

/**
 * 等待 write stream 的 close 事件。
 * pipeline() 只保证 finish（数据已 flush），close 才代表底层 fd 已释放；
 * 在 APFS/macOS 上若 fd 尚未释放就 rename，会偶发 EPERM。
 */
function waitForStreamClose(stream: fsSync.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (stream.closed) {
      resolve();
      return;
    }
    stream.once('close', () => resolve());
    stream.once('error', reject);
  });
}

const RENAME_RETRY_DELAY_MS = 75;
const RENAME_MAX_RETRIES = 3;

/**
 * 原子改名。APFS/macOS 上偶发 EPERM：文件系统尚未释放刚写完的 inode，
 * 短暂重试可自愈；重试耗尽后原样抛出。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      // eslint-disable-next-line perf/perf-no-serial-await -- retry loop: each attempt depends on previous failure
      await fs.rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') throw err;
      if (attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

/** 写入清单并落盘：先写 .tmp 再原子改名，失败清理临时文件 */
async function finalizeZip(params: FinalizeZipParams): Promise<void> {
  const { zip, fileEntries, timestamp, tmpZipPath, zipPath, abortSignal } = params;
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
    const output = fsSync.createWriteStream(tmpZipPath);
    await pipeline(zip.outputStream, output);
    // pipeline() 只等待 finish；显式等待 write stream 的 close，确保底层 fd 真正释放
    await waitForStreamClose(output);
    if (abortSignal?.aborted) {
      await fs.rm(tmpZipPath, { force: true }).catch(() => {});
    } else {
      await renameWithRetry(tmpZipPath, zipPath);
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
  const output = fsSync.createWriteStream(targetPath);
  await pipeline(stream, output);
  // 与 finalizeZip 一致：显式等待 write stream close，确保 fd 释放后再返回
  await waitForStreamClose(output);
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

/** 从归档内读取 BACKUP_MANIFEST.json 清单；缺失或格式不合法时按空清单处理 */
async function readManifestFiles(
  archive: Awaited<ReturnType<typeof openZipArchive>>,
): Promise<LocalBackupFileEntry[]> {
  const manifestEntry = archive.entriesByName.get('BACKUP_MANIFEST.json');
  const manifestBuf = manifestEntry ? await archive.readEntry(manifestEntry) : null;
  if (!manifestBuf) return [];
  const parsed: unknown = JSON.parse(manifestBuf.toString('utf-8'));
  const files =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).files
      : undefined;
  if (!Array.isArray(files)) return [];
  return files as LocalBackupFileEntry[];
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

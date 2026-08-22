/**
 * 一键备份系统 — 备份条目还原辅助（gzip 魔数嗅探兜底旧版目录）
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import type { LocalBackupCompression, LocalBackupFileEntry } from './local-backup';

/** gzip 魔数（RFC 1952：0x1f 0x8b） */
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 读取文件头部字节并判断 gzip 魔数；文件不存在或过短返回 false */
async function hasGzipMagic(filePath: string): Promise<boolean> {
  let head: Buffer;
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(GZIP_MAGIC.length);
      const { bytesRead } = await handle.read(buf, 0, GZIP_MAGIC.length, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
  return head.length === GZIP_MAGIC.length && head.equals(GZIP_MAGIC);
}

/** 定位条目实际落盘文件并判定压缩格式；找不到时抛出明确错误 */
async function locateStoredFile(
  backupPath: string,
  entry: LocalBackupFileEntry,
): Promise<{ sourcePath: string; compression: LocalBackupCompression }> {
  const storedName = entry.storedAs ?? entry.relativePath;
  const primary = path.join(backupPath, storedName);

  if (await pathExists(primary)) {
    return { sourcePath: primary, compression: entry.compression ?? 'none' };
  }

  const gzCandidate = `${primary}.gz`;
  if (await hasGzipMagic(gzCandidate)) {
    return { sourcePath: gzCandidate, compression: 'gzip' };
  }

  throw new Error(`备份文件缺失（期望 ${storedName}）`);
}

export async function restoreStoredEntry(
  backupPath: string,
  targetPath: string,
  entry: LocalBackupFileEntry,
): Promise<void> {
  const { sourcePath, compression } = await locateStoredFile(backupPath, entry);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (compression === 'gzip') {
    if (!(await hasGzipMagic(sourcePath))) {
      throw new Error('清单标记为 gzip，但内容缺少 gzip 魔数');
    }
    await pipeline(
      fsSync.createReadStream(sourcePath),
      createGunzip(),
      fsSync.createWriteStream(targetPath),
    );
    return;
  }

  if (await hasGzipMagic(sourcePath)) {
    throw new Error('清单标记为未压缩，但内容实为 gzip 数据');
  }
  await fs.cp(sourcePath, targetPath, { preserveTimestamps: true });
}

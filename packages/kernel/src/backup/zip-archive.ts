/**
 * 一键备份系统 — zip 归档读写辅助（yauzl 回调 API 的 Promise 封装）
 */
import * as path from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';

export interface ZipArchiveReader {
  entriesByName: Map<string, yauzl.Entry>;
  readEntry(entry: yauzl.Entry): Promise<Buffer>;
  openEntryStream(entry: yauzl.Entry): Promise<Readable>;
  close(): void;
}

export function openZipArchive(zipPath: string): Promise<ZipArchiveReader> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error(`无法打开 zip 归档：${zipPath}`));
        return;
      }

      const entriesByName = new Map<string, yauzl.Entry>();
      let settled = false;
      const fail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };

      zipfile.on('error', fail);
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (!entry.fileName.endsWith('/')) {
          entriesByName.set(entry.fileName, entry);
        }
        if (!settled) zipfile.readEntry();
      });
      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve({
            entriesByName,
            async readEntry(target) {
              const stream = await openEntryStream(zipfile, target);
              const chunks: Buffer[] = [];
              for await (const chunk of stream) {
                chunks.push(chunk as Buffer);
              }
              return Buffer.concat(chunks);
            },
            openEntryStream(target) {
              return openEntryStream(zipfile, target);
            },
            close() {
              zipfile.close();
            },
          });
        }
      });

      zipfile.readEntry();
    });
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err || !stream) {
        reject(err ?? new Error(`无法读取 zip 条目：${entry.fileName}`));
        return;
      }
      resolve(stream);
    });
  });
}

export function toZipEntryName(absolutePath: string, projectRoot: string): string {
  return path.relative(projectRoot, absolutePath).split(path.sep).join('/');
}

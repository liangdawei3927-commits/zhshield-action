import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { ToolRuleSync } from '../sop/sync/tool-rule-sync';
import { restoreFromZipArchive } from '../backup/zip-snapshot';
import type { LocalBackupManifest } from '../backup/local-backup';

const workRoot = path.join(os.tmpdir(), `zhshield-path-traversal-${crypto.randomUUID()}`);

afterAll(async () => {
  await fs.rm(workRoot, { recursive: true, force: true });
});

/** 最小 ZIP 写入器（stored 无压缩），允许任意条目名（含 `..`），供防御纵深测试构造恶意归档 */
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

describe('tool-rule-sync extractRules 路径穿越加固', () => {
  it('跳过越界 filename，不写盘到 targetDir 之外，合法条目正常写入', async () => {
    const targetDir = path.join(workRoot, 'rules');
    const escaped = path.resolve(targetDir, '../ESCAPED/pwned.txt');

    const payload = Buffer.from(
      JSON.stringify([
        { filename: '../ESCAPED/pwned.txt', content: 'PWNED' },
        { filename: 'ok.json', content: 'x' },
      ]),
    );

    await new ToolRuleSync([]).extractRules(payload, targetDir);

    expect(fsSync.existsSync(escaped)).toBe(false);
    expect(await fs.readFile(path.join(targetDir, 'ok.json'), 'utf-8')).toBe('x');
  });
});

describe('restoreFromZipArchive 路径穿越防御纵深', () => {
  it('越界 relativePath 绝不写盘到 targetDir 之外（无论底层 zip 库是否拦截）', async () => {
    const targetDir = path.join(workRoot, 'restore');
    const escaped = path.resolve(targetDir, '../evil.txt');
    const zipPath = path.join(workRoot, 'evil.zip');

    const manifest: LocalBackupManifest = {
      version: '1.0',
      sourceDir: 'x',
      lastBackupAt: '2026-08-28T00:00:00.000Z',
      fullBackupAt: '2026-08-28T00:00:00.000Z',
      files: [
        { relativePath: '../evil.txt', hash: 'x', size: 5, backedUpAt: '2026-08-28T00:00:00.000Z' },
      ],
    };

    const zip = buildZip([
      {
        name: 'BACKUP_MANIFEST.json',
        data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'),
      },
      { name: '../evil.txt', data: Buffer.from('EVIL!', 'utf-8') },
    ]);
    await fs.writeFile(zipPath, zip);

    let outcome: 'threw' | 'returned' = 'returned';
    let failed = 0;
    try {
      const result = await restoreFromZipArchive(zipPath, targetDir);
      failed = result.failed;
    } catch {
      // yauzl 在 open 阶段拒绝含 `..` 的条目名，此时整体抛错
      outcome = 'threw';
    }

    // 关键断言：无论哪种路径，越界文件都不得被创建
    expect(fsSync.existsSync(escaped)).toBe(false);

    if (outcome === 'returned') {
      // 若底层库放行，则防御纵深必须将其计为失败
      expect(failed).toBeGreaterThan(0);
    }
  });
});

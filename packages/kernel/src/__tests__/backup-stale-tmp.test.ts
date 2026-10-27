/**
 * A3 回归测试（2026-10-27 核实）：中断残留的 `.zip.tmp` 必须有清理路径。
 *
 * 背景：`LocalBackup.listBackups` 的 `SNAPSHOT_NAME_RE` 只认完整快照名，
 * `.zip.tmp` 永远进不了轮换清理 —— 实测本机堆了 5 份共约 3.3GB 死文件。
 *
 * 双自证要求（见 zhshield-inspect-verify）：既要证「该清的清掉」，也要证
 * 「不该清的绝不碰」—— 正在写的临时文件（mtime 新）与完整快照都必须存活。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  utimesSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalBackupPruner,
  DEFAULT_TMP_SNAPSHOT_TTL_MS,
} from '../backup/local-backup-pruner';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'zh-tmp-prune-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 造一个文件并把 mtime 拨到 `ageMs` 之前 */
function touch(name: string, ageMs: number): string {
  const p = join(root, name);
  writeFileSync(p, 'x');
  const at = new Date(Date.now() - ageMs);
  utimesSync(p, at, at);
  return p;
}

describe('A3 中断残留临时快照清理', () => {
  it('mtime 超过 TTL 的 .zip.tmp 被删除', async () => {
    const stale = touch('2026-10-25T16-00-17-572Z.zip.tmp', 25 * 60 * 60 * 1000);
    const outcome = await new LocalBackupPruner().pruneStaleTmpFiles(root);
    expect(outcome.removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
  });

  it('正在写的 .zip.tmp（mtime 新）必须保留', async () => {
    const fresh = touch('2026-10-27T16-00-00-000Z.zip.tmp', 60 * 1000);
    const outcome = await new LocalBackupPruner().pruneStaleTmpFiles(root);
    expect(outcome.removed).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });

  it('完整快照 .zip 与快照目录都不受影响（只认 .zip.tmp 后缀）', async () => {
    const zip = touch('2026-10-24T16-00-11-417Z.zip', 72 * 60 * 60 * 1000);
    const dir = join(root, '2026-10-20T16-00-00-000Z');
    mkdirSync(dir);
    const outcome = await new LocalBackupPruner().pruneStaleTmpFiles(root);
    expect(outcome.removed).toEqual([]);
    expect(existsSync(zip)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('mtime 在未来（时钟回拨）按新鲜处理，不误删', async () => {
    const future = touch('2026-12-01T00-00-00-000Z.zip.tmp', -10 * 24 * 60 * 60 * 1000);
    const outcome = await new LocalBackupPruner().pruneStaleTmpFiles(root);
    expect(outcome.removed).toEqual([]);
    expect(existsSync(future)).toBe(true);
  });

  it('ttl 可注入：同一份文件在更大阈值下存活、更小阈值下被清', async () => {
    const file = touch('2026-10-26T16-00-27-987Z.zip.tmp', 2 * 60 * 60 * 1000);
    const pruner = new LocalBackupPruner();
    // 默认 24h：2 小时前的文件是「可能仍在写」，保留
    expect((await pruner.pruneStaleTmpFiles(root)).removed).toEqual([]);
    expect(existsSync(file)).toBe(true);
    // 显式 1h：判为死文件
    const outcome = await pruner.pruneStaleTmpFiles(root, 60 * 60 * 1000);
    expect(outcome.removed).toEqual([file]);
  });

  it('备份根目录不存在时安全返回空结果（首次备份）', async () => {
    const outcome = await new LocalBackupPruner().pruneStaleTmpFiles(
      join(root, 'not-exist-yet'),
    );
    expect(outcome).toEqual({ removed: [], failed: [] });
  });

  it('默认 TTL 是 24 小时（与文档/注释一致）', () => {
    expect(DEFAULT_TMP_SNAPSHOT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

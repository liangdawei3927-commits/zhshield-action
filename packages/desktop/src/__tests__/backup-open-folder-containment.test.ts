import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** 被 shell 真正打开的路径：用于断言「越界路径从未抵达 shell」 */
const OPENED: string[] = [];
/** 被 mock 的项目备份配置目录 */
const CONFIG_BACKUP_DIR = { value: '' };

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/zh-backup-openfolder-test') },
  shell: {
    showItemInFolder: (p: string) => {
      OPENED.push(p);
    },
    openPath: async (p: string) => {
      OPENED.push(p);
      return '';
    },
  },
}));

// 仅替换 BackupConfigManager 以注入临时备份根；其余导出（DEFAULT_BACKUP_ROOT 等）
// 必须保留 spread，否则 backup.ts 的具名 import 会因 mock 缺项而抛错。
vi.mock('@zh/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zh/kernel')>();
  return {
    ...actual,
    BackupConfigManager: class {
      async loadProjectConfig() {
        return { local: { backupDir: CONFIG_BACKUP_DIR.value } };
      }
    },
  };
});

import { openBackupFolder } from '../../electron/ipc/backup';

/**
 * backup:openFolder 路径包含性校验（接线层）
 *
 * 2026-10-02：folderPath 逐字取自 <userData>/backup-records.json，该文件仅经
 * JSON.parse 而无任何校验。篡改它即可让一次「打开备份目录」点击把 Finder 指向
 * 任意绝对路径。修复方式为开目录前确认目标仍落在该项目备份根内。
 *
 * 关键：断言对象是 shell 实际收到的路径（OPENED），而非仅调用判定函数。
 * 只测判定函数会在删除调用点守卫后依然全绿，无法证明校验真正接在开目录路径上。
 */
describe('backup:openFolder 越界路径不得抵达 shell', () => {
  let root: string;
  let inside: string;
  let outside: string;

  beforeEach(() => {
    OPENED.length = 0;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zh-openfolder-')));
    inside = path.join(root, 'proj', 'snapshot-1');
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zh-outside-')));
    fs.mkdirSync(inside, { recursive: true });
    CONFIG_BACKUP_DIR.value = root;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('放行备份根内的快照目录并交给 shell', async () => {
    await expect(openBackupFolder('/proj', inside)).resolves.toBe(true);
    expect(OPENED).toEqual([inside]);
  });

  it('拒绝根外绝对路径：shell 从未被调用', async () => {
    await expect(openBackupFolder('/proj', outside)).resolves.toBe(false);
    expect(OPENED).toEqual([]);
  });

  it('拒绝 /etc：shell 从未被调用', async () => {
    await expect(openBackupFolder('/proj', '/etc')).resolves.toBe(false);
    expect(OPENED).toEqual([]);
  });

  it('拒绝 ../ 词法逃逸：shell 从未被调用', async () => {
    await expect(openBackupFolder('/proj', path.join(root, '..', 'escape'))).resolves.toBe(false);
    expect(OPENED).toEqual([]);
  });

  it('拒绝前缀相似但非子路径的目录：shell 从未被调用', async () => {
    const sibling = fs.mkdtempSync(`${root}-evil`);
    try {
      await expect(openBackupFolder('/proj', sibling)).resolves.toBe(false);
      expect(OPENED).toEqual([]);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('拒绝指向根外的符号链接（realpath 逃逸）：shell 从未被调用', async () => {
    const link = path.join(root, 'evil-link');
    fs.symlinkSync(outside, link, 'dir');
    await expect(openBackupFolder('/proj', link)).resolves.toBe(false);
    expect(OPENED).toEqual([]);
  });

  it('放行指向根内的符号链接', async () => {
    const link = path.join(root, 'good-link');
    fs.symlinkSync(inside, link, 'dir');
    await expect(openBackupFolder('/proj', link)).resolves.toBe(true);
    expect(OPENED).toEqual([link]);
  });

  it('快照已被轮转删除时，回退到根的父级仍可打开（不得误伤合法路径）', async () => {
    const gone = path.join(root, 'proj', 'snapshot-rotated-away');
    await expect(openBackupFolder('/proj', gone)).resolves.toBe(true);
    expect(OPENED).toHaveLength(1);
  });

  it('快照是 zip 文件时用 showItemInFolder 高亮，且仍受包含性约束', async () => {
    const zip = path.join(root, 'proj', 'snapshot.zip');
    fs.writeFileSync(zip, 'x');
    await expect(openBackupFolder('/proj', zip)).resolves.toBe(true);
    expect(OPENED).toEqual([zip]);
  });

  it('空路径直接拒绝，不触碰 shell', async () => {
    await expect(openBackupFolder('/proj', '')).resolves.toBe(false);
    expect(OPENED).toEqual([]);
  });

  /**
   * 2026-10-24 回归：真实 .zhshield/backup.yml 里写的是 `~/zhshield-backups/<project>`
   * （字面量 ~，BackupConfigManager 不做展开）。旧实现求根时用 resolve('~/…')，
   * 得到 `<cwd>/~/…`，与打开端自行展开后的绝对路径永不包含 → 所有备份目录都打不开，
   * 界面却提示「路径可能已被清理」。上面所有用例都传绝对路径，因此全部漏掉了这个情形。
   */
  it('配置里的备份根为 ~ 前缀时仍能打开（~ 必须展开后再做包含性校验）', async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.homedir(), '.zh-openfolder-tilde-'));
    try {
      const snap = path.join(homeRoot, 'proj', 'snapshot-1');
      fs.mkdirSync(snap, { recursive: true });
      CONFIG_BACKUP_DIR.value = `~/${path.relative(os.homedir(), homeRoot)}`;
      await expect(openBackupFolder('/proj', snap)).resolves.toBe(true);
      expect(OPENED).toEqual([snap]);
    } finally {
      fs.rmSync(homeRoot, { recursive: true, force: true });
    }
  });

  it('~ 前缀的根同样不能放行根外路径', async () => {
    const homeRoot = fs.mkdtempSync(path.join(os.homedir(), '.zh-openfolder-tilde-'));
    try {
      CONFIG_BACKUP_DIR.value = `~/${path.relative(os.homedir(), homeRoot)}`;
      await expect(openBackupFolder('/proj', outside)).resolves.toBe(false);
      expect(OPENED).toEqual([]);
    } finally {
      fs.rmSync(homeRoot, { recursive: true, force: true });
    }
  });
});
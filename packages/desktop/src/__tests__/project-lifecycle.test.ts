/**
 * 归还链第 5 步单测(project-lifecycle.test.ts)
 *
 * R2 规格验收 4(06 §3.4 ⑥):cleanupProjectAfterRemoval 删除项目后,
 * ledger 中该项目 id 从所有能力 refs 移除;getCachedProfileProjectPath 与
 * cachedProfile 清理行为不受影响;步骤 5 失败仅 warn 不抛(§2.3)。
 *
 * 全部副作用注入 tmpDir 或 mock,绝不写真实 ~/.zhshield:
 * - @zh/fingerprint 的 createProfileStore → mock(画像删除不落真实 home)
 * - @zh/db 的 softDeleteProjectData → mock(不动真实数据库)
 * - ./ipc-context → mock(getDb/getCachedProfileProjectPath/setCachedProfile/
 *   unregisterProjectFeaturesFromCloud 全部注入)
 * - ./capability-refs → 保留真实纯函数(releaseProjectRefs/deriveProjectId),
 *   仅 loadCapabilityRefs/saveCapabilityRefs 重定向到 tmpDir 文件
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const h = vi.hoisted(() => ({
  createProfileStore: vi.fn(),
  softDeleteProjectData: vi.fn(),
  getDb: vi.fn(),
  getCachedProfileProjectPath: vi.fn(),
  setCachedProfile: vi.fn(),
  unregisterProjectFeaturesFromCloud: vi.fn(),
  loadCapabilityRefs: vi.fn(),
  saveCapabilityRefs: vi.fn(),
}));

vi.mock('@zh/fingerprint', () => ({
  createProfileStore: h.createProfileStore,
}));

vi.mock('@zh/db', () => ({
  softDeleteProjectData: h.softDeleteProjectData,
}));

vi.mock('../../electron/ipc-context', () => ({
  getDb: h.getDb,
  getCachedProfileProjectPath: h.getCachedProfileProjectPath,
  setCachedProfile: h.setCachedProfile,
  unregisterProjectFeaturesFromCloud: h.unregisterProjectFeaturesFromCloud,
}));

vi.mock('../../electron/capability-refs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/capability-refs')>();
  return {
    ...actual,
    loadCapabilityRefs: h.loadCapabilityRefs,
    saveCapabilityRefs: h.saveCapabilityRefs,
  };
});

import {
  capabilityIdOf,
  deriveProjectId,
  type CapabilityRefs,
} from '../../electron/capability-refs';
import { cleanupProjectAfterRemoval } from '../../electron/project-lifecycle';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-project-lifecycle-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.unregisterProjectFeaturesFromCloud.mockResolvedValue(undefined);
  h.getDb.mockReturnValue(undefined);
});

/** 预置账本:eslint 被 projA/projB 共享,semgrep 仅 projA 引用,均 active */
function presetLedger(projAId: string, projBId: string): CapabilityRefs {
  return {
    schemaVersion: 1,
    capabilities: {
      [capabilityIdOf('eslint')]: { languages: [], refs: [projAId, projBId], status: 'active' },
      [capabilityIdOf('semgrep')]: { languages: [], refs: [projAId], status: 'active' },
    },
  };
}

describe('归还链第 5 步:删项目后 ledger 移除 projectId(验收 4)', () => {
  it('删 projA → eslint.refs=[projB] 保持 active,semgrep refs 空 → reclaiming + since', async () => {
    const dir = makeTmpDir();
    const ledgerPath = path.join(dir, 'capability-refs.json');
    const projA = '/fake/path/projA';
    const projB = '/fake/path/projB';
    const projAId = deriveProjectId(projA);
    const projBId = deriveProjectId(projB);

    h.loadCapabilityRefs.mockReturnValue(presetLedger(projAId, projBId));
    h.saveCapabilityRefs.mockImplementation((refs: CapabilityRefs) => {
      fs.writeFileSync(ledgerPath, JSON.stringify(refs, null, 2), 'utf-8');
    });
    const deleteProfile = vi.fn();
    h.createProfileStore.mockReturnValue({ delete: deleteProfile });

    await cleanupProjectAfterRemoval(projA);

    // 步骤 1-4 链上副作用照常执行
    expect(deleteProfile).toHaveBeenCalledWith(projA);
    expect(h.softDeleteProjectData).toHaveBeenCalledWith(undefined, projA);
    expect(h.unregisterProjectFeaturesFromCloud).toHaveBeenCalledWith(projA);

    // 步骤 5:saveCapabilityRefs 收到 release 后的账本并真实落盘 tmpDir
    expect(h.saveCapabilityRefs).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as CapabilityRefs;
    const eslint = saved.capabilities[capabilityIdOf('eslint')];
    expect(eslint.refs).toEqual([projBId]);
    expect(eslint.status).toBe('active');
    expect(eslint.since).toBeUndefined();
    const semgrep = saved.capabilities[capabilityIdOf('semgrep')];
    expect(semgrep.refs).toEqual([]);
    expect(semgrep.status).toBe('reclaiming');
    expect(typeof semgrep.since).toBe('number');
  });
});

describe('cachedProfile 清理行为不受影响', () => {
  it('缓存归属被删项目 → setCachedProfile(null, null) 被调用（同时清空画像与归属 path）', async () => {
    const dir = makeTmpDir();
    const ledgerPath = path.join(dir, 'capability-refs.json');
    const projA = '/fake/path/projA';

    h.loadCapabilityRefs.mockReturnValue({ schemaVersion: 1, capabilities: {} });
    h.saveCapabilityRefs.mockImplementation((refs: CapabilityRefs) => {
      fs.writeFileSync(ledgerPath, JSON.stringify(refs, null, 2), 'utf-8');
    });
    h.getCachedProfileProjectPath.mockReturnValue(projA);
    h.createProfileStore.mockReturnValue({ delete: vi.fn() });

    await cleanupProjectAfterRemoval(projA);

    expect(h.getCachedProfileProjectPath).toHaveBeenCalled();
    // 生产修复：第二参传 null 才会同时清空归属 path（仅传 null 时 path 保持不变）
    expect(h.setCachedProfile).toHaveBeenCalledWith(null, null);
  });

  it('缓存归属其他项目 → setCachedProfile 不被调用(宁缺毋滥)', async () => {
    const dir = makeTmpDir();
    const ledgerPath = path.join(dir, 'capability-refs.json');
    const projA = '/fake/path/projA';
    const other = '/fake/path/other';

    h.loadCapabilityRefs.mockReturnValue({ schemaVersion: 1, capabilities: {} });
    h.saveCapabilityRefs.mockImplementation((refs: CapabilityRefs) => {
      fs.writeFileSync(ledgerPath, JSON.stringify(refs, null, 2), 'utf-8');
    });
    h.getCachedProfileProjectPath.mockReturnValue(other);
    h.createProfileStore.mockReturnValue({ delete: vi.fn() });

    await cleanupProjectAfterRemoval(projA);

    expect(h.setCachedProfile).not.toHaveBeenCalled();
  });
});

describe('步骤 5 失败降级不抛(规格 §2.3)', () => {
  it('saveCapabilityRefs throw → cleanup 仍 resolve 且 console.warn 记录', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const projA = '/fake/path/projA';

    h.loadCapabilityRefs.mockReturnValue({ schemaVersion: 1, capabilities: {} });
    h.saveCapabilityRefs.mockImplementation(() => {
      throw new Error('disk full');
    });
    h.createProfileStore.mockReturnValue({ delete: vi.fn() });

    await expect(cleanupProjectAfterRemoval(projA)).resolves.toEqual([
      { step: 'profile-delete', status: 'ok' },
      { step: 'db-soft-delete', status: 'ok' },
      { step: 'memory-release', status: 'ok' },
      { step: 'cloud-unregister', status: 'ok' },
      { step: 'capability-refs-release', status: 'failed', error: 'disk full' },
    ]);

    expect(warnSpy).toHaveBeenCalled();
  });
});
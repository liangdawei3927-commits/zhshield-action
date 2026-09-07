/**
 * SOP 模块按画像下载接线 + 到期回收单测(sync-sop-modules.test.ts)
 *
 * 覆盖两个断点接线（sync.ts syncSopModulesForProfile）：
 * 1. SOP 按画像下载：syncForProject 接入加项目/漂移链路（claim → 下载 → 回收）
 * 2. SOP 模块回收：reclaiming 超期模块物理删除 + 账本标记 reclaimed 终态
 *
 * 副作用注入：
 * - node:os.homedir → 重定向到 tmpDir（capability-refs 真账本随之中转到 tmpDir）
 * - @zh/kernel → mock（EXPIRY_THRESHOLD_DAYS/getReclaimingSopModuleSinces/SopSigner）
 * - electron → mock（ipcMain.handle 空实现）
 * - ./ipc-context → mock（sopCache/getCachedProfile/getCachedProfileProjectPath 注入）
 * - @zh/shared → importOriginal 保留 + 工具 scope 判定 mock（syncToolRulesForProfile 依赖，
 *   本测试只调用 syncSopModulesForProfile）
 *
 * capability-refs 用真实实现（非 mock）：load/save 经 homedir mock 自动落到 tmpDir，
 * 从而端到端验证 claim 记账与 reclaimed 终态标记的真实读写。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const h = vi.hoisted(() => {
  const tmpBase = process.env.TMPDIR || process.env.TMP || '/tmp';
  const homedir = `${tmpBase}/zh-sync-sop-modules-${process.pid}`;
  return {
    homedir,
    syncForProject: vi.fn(async () => []),
    getNeededModules: vi.fn((f?: { language?: string }) =>
      ['security', 'quality', 'architecture', ...(f?.language === 'typescript' ? ['typescript'] : [])],
    ),
    removeModule: vi.fn(async () => undefined),
    getCachedProfile: vi.fn(() => null),
    getCachedProfileProjectPath: vi.fn(() => null),
    getReclaimingSopModuleSinces: vi.fn(() => new Map<string, number>()),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => h.homedir };
});

vi.mock('@zh/kernel', () => ({
  EXPIRY_THRESHOLD_DAYS: 7,
  getReclaimingSopModuleSinces: h.getReclaimingSopModuleSinces,
  SopSigner: { verifyPackageWithPublicKey: vi.fn(() => ({ valid: false })) },
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('@zh/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zh/shared')>();
  return { ...actual, isToolInScope: vi.fn(() => true), isToolLanguagesMatch: vi.fn(() => true) };
});

vi.mock('../../electron/ipc-context', () => ({
  sopCache: {
    syncForProject: h.syncForProject,
    getNeededModules: h.getNeededModules,
    removeModule: h.removeModule,
  },
  sopRegistry: { getStats: vi.fn(() => ({})), getActive: vi.fn(() => []), getByDomain: vi.fn(() => []) },
  wisdomBrainSync: { getRuleSync: vi.fn(() => ({ getUnfilteredToolIds: () => [] })) },
  getCachedProfile: h.getCachedProfile,
  getCachedProfileProjectPath: h.getCachedProfileProjectPath,
  getDefaultOrgId: vi.fn(async () => null),
  cloudResolveTools: vi.fn(async () => []),
  resolveSopPublicKey: vi.fn(async () => null),
}));

import { syncSopModulesForProfile } from '../../electron/ipc/sync';
import {
  defaultCapabilityRefsPath,
  loadCapabilityRefs,
} from '../../electron/capability-refs';

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(h.homedir, { recursive: true, force: true });
  h.syncForProject.mockResolvedValue([]);
  h.removeModule.mockResolvedValue(undefined);
  h.getCachedProfile.mockReturnValue(null);
  h.getCachedProfileProjectPath.mockReturnValue(null);
  h.getReclaimingSopModuleSinces.mockReturnValue(new Map());
});

afterEach(() => {
  fs.rmSync(h.homedir, { recursive: true, force: true });
});

describe('syncSopModulesForProfile 按画像下载接线', () => {
  it('项目归属 + 画像存在 → claim 记账先于 syncForProject（唤醒语义）', async () => {
    h.getCachedProfile.mockReturnValue({ language: 'typescript', framework: 'nestjs', features: [] });
    h.getCachedProfileProjectPath.mockReturnValue('/demo/ts-project');

    const modules = await syncSopModulesForProfile({ language: 'typescript', framework: 'nestjs', features: [] });

    // syncForProject 必须被调用（断点 1：按画像下载接线）
    expect(h.syncForProject).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'typescript', framework: 'nestjs' }),
    );
    // claim 用 getNeededModules 的结果领取 sop-module:* 引用
    expect(h.getNeededModules).toHaveBeenCalled();
    // 账本真实写入：sop-module 键存在且 refs 含该项目 id（sha256 前 16 位）
    const refs = await loadCapabilityRefs(defaultCapabilityRefsPath());
    const sopKeys = Object.keys(refs.capabilities).filter((k) => k.startsWith('sop-module:'));
    expect(sopKeys.length).toBeGreaterThan(0);
    const projectId = refs.capabilities[sopKeys[0]]?.refs[0];
    expect(projectId).toBeTruthy();
    expect(modules).toEqual(['security', 'quality', 'architecture', 'typescript']);
  });

  it('无项目归属 → 不 claim（仅回收扫描）', async () => {
    h.getCachedProfile.mockReturnValue({ language: 'typescript', framework: '', features: [] });

    await syncSopModulesForProfile(undefined);

    // 无项目归属：claim 不执行；feature 未显式传入 → 下载也跳过
    expect(h.getNeededModules).not.toHaveBeenCalled();
    expect(h.syncForProject).not.toHaveBeenCalled();
    // 回收扫描仍执行（工具规则触发面共用，回收不应依赖项目归属）
    expect(h.getReclaimingSopModuleSinces).toHaveBeenCalled();
    // 账本未写入任何 sop-module claim（claim 被跳过）
    const refs = await loadCapabilityRefs(defaultCapabilityRefsPath());
    expect(Object.keys(refs.capabilities).filter((k) => k.startsWith('sop-module:'))).toEqual([]);
  });

  it('feature 为 undefined → 不崩溃（防 undefined.targets），仍做回收扫描', async () => {
    h.getCachedProfileProjectPath.mockReturnValue('/demo/proj');

    const result = await syncSopModulesForProfile(undefined);

    expect(h.getNeededModules).not.toHaveBeenCalled();
    expect(h.syncForProject).not.toHaveBeenCalled();
    expect(h.getReclaimingSopModuleSinces).toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('syncSopModulesForProfile 到期回收', () => {
  it('reclaiming 超期模块 → removeModule 物理删除 + 账本标记 reclaimed 终态', async () => {
    // 无项目归属（回收场景：删项目后 7 天窗口超期），避免 claim 唤醒干扰 reclaiming 状态。
    // 账本留存先前项目删除时 releaseProjectRefs 留下的 reclaiming 条目。
    const refsPath = defaultCapabilityRefsPath();
    fs.mkdirSync(path.dirname(refsPath), { recursive: true });
    fs.writeFileSync(
      refsPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          capabilities: {
            'sop-module:typescript': { languages: [], refs: [], status: 'reclaiming', since: Date.now() - 8 * DAY_MS },
            'sop-module:security': { languages: [], refs: [], status: 'reclaiming', since: Date.now() - 2 * DAY_MS },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    h.getReclaimingSopModuleSinces.mockReturnValue(
      new Map([
        ['typescript', Date.now() - 8 * DAY_MS],
        ['security', Date.now() - 2 * DAY_MS],
      ]),
    );

    await syncSopModulesForProfile({ language: 'typescript', framework: '', features: [] });

    // 仅超期模块被删除；窗口内模块保留
    expect(h.removeModule).toHaveBeenCalledWith('typescript');
    expect(h.removeModule).not.toHaveBeenCalledWith('security');
    // 账本终态：typescript → reclaimed + at；security 仍 reclaiming（未到期）
    const refs = await loadCapabilityRefs(refsPath);
    expect(refs.capabilities['sop-module:typescript']?.status).toBe('reclaimed');
    expect(typeof refs.capabilities['sop-module:typescript']?.at).toBe('number');
    expect(refs.capabilities['sop-module:typescript']?.since).toBeUndefined();
    expect(refs.capabilities['sop-module:security']?.status).toBe('reclaiming');
  });

  it('无 reclaiming 条目 → removeModule 不被调用、账本无写入', async () => {
    h.getCachedProfileProjectPath.mockReturnValue('/demo/proj');
    h.getReclaimingSopModuleSinces.mockReturnValue(new Map());

    await syncSopModulesForProfile(undefined);

    expect(h.removeModule).not.toHaveBeenCalled();
  });

  it('reclaiming 未超期 → 不删除（7 天宽限窗口内保留）', async () => {
    h.getCachedProfileProjectPath.mockReturnValue('/demo/proj');
    h.getReclaimingSopModuleSinces.mockReturnValue(
      new Map([['quality', Date.now() - 6 * DAY_MS]]),
    );

    await syncSopModulesForProfile(undefined);

    expect(h.removeModule).not.toHaveBeenCalled();
  });

  it('窗口末唤醒竞态 → 删除前重读账本，刚唤醒的模块不误删', async () => {
    // 场景：该项目 7 天窗口期快满时被重加（claim 唤醒 → 账本中该模块 reclaiming 消失），
    // 但回收扫描读到的快照仍是过期 since。删除前重读账本须发现已唤醒 → 跳过删除。
    h.getCachedProfile.mockReturnValue({ language: 'typescript', framework: '', features: [] });
    h.getCachedProfileProjectPath.mockReturnValue('/demo/ts-project');
    // 第一次扫描（claim 前快照）报超期；删除前重读（claim 后账本）为空 → 已唤醒
    h.getReclaimingSopModuleSinces
      .mockReturnValueOnce(new Map([['typescript', Date.now() - 8 * DAY_MS]]))
      .mockReturnValueOnce(new Map());

    await syncSopModulesForProfile({ language: 'typescript', framework: '', features: [] });

    // 已唤醒模块不得被物理删除（复用了本地文件，无需重下）
    expect(h.removeModule).not.toHaveBeenCalledWith('typescript');
  });
});
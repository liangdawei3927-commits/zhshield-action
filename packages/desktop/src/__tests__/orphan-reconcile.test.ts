/**
 * 空项目集宽限 + 全局重置单测(orphan-reconcile.test.ts)
 *
 * R 需求项：客户端删除全部项目后进入 7 天宽限；期内重加项目取消重置；
 * 超期则全局重置（清画像 trash / SOP 缓存 / 工具规则 / 能力账本 / DB 软删行）。
 *
 * 全部副作用注入 tmpDir（homedir mock 重定向）或 mock，绝不写真实 ~/.zhshield：
 * - node:os.homedir → 重定向到 tmpDir（PROFILES_DIR/STATE_FILE 随之中转）
 * - @zh/db → mock（softDelete/list/purge 全部注入）
 * - @zh/shared AuditLogger → mock（不落真实审计盘）
 * - ./ipc-context → mock（getDb/sopCache/wisdomBrainSync 注入）
 * - ./ipc/projects → mock（PROJECTS_FILE 指向 tmpDir）
 * - ./capability-refs → mock（saveCapabilityRefs/loadCapabilityRefs 注入）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const h = vi.hoisted(() => {
  const tmpBase = process.env.TMPDIR || process.env.TMP || '/tmp';
  const homedir = `${tmpBase}/zh-orphan-reconcile-${process.pid}`;
  const projectsFile = `${homedir}/projects.json`;
  const stateFile = `${homedir}/.zhshield/orphan-state.json`;
  const profilesDir = `${homedir}/.zhshield/profiles`;
  const trashDir = `${profilesDir}/trash`;
  const ruleSync = {
    getUnfilteredToolIds: vi.fn(() => []),
    getRuleDir: vi.fn(() => ''),
    removeRules: vi.fn(async () => undefined),
  };
  return {
    homedir,
    projectsFile,
    stateFile,
    profilesDir,
    trashDir,
    ruleSync,
    wisdomBrainSync: { getRuleSync: () => ruleSync },
    sopCache: { clearCache: vi.fn(async () => undefined) },
    getDb: vi.fn(() => ({})),
    listActiveProjectIds: vi.fn(() => []),
    listSoftDeletedProjectIds: vi.fn(() => []),
    countActiveRows: vi.fn(() => []),
    softDeleteProjectData: vi.fn(),
    purgeExpiredSoftDeleted: vi.fn(() => []),
    loadCapabilityRefs: vi.fn(async () => ({ schemaVersion: 1, capabilities: {} })),
    saveCapabilityRefs: vi.fn(async () => undefined),
    logOrphanCleanup: vi.fn(async () => undefined),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => h.homedir };
});

vi.mock('@zh/db', () => ({
  softDeleteProjectData: h.softDeleteProjectData,
  listActiveProjectIds: h.listActiveProjectIds,
  listSoftDeletedProjectIds: h.listSoftDeletedProjectIds,
  countActiveRows: h.countActiveRows,
  purgeExpiredSoftDeleted: h.purgeExpiredSoftDeleted,
}));

vi.mock('@zh/shared', () => ({
  AuditLogger: class {
    logOrphanCleanup = h.logOrphanCleanup;
  },
}));

vi.mock('../../electron/ipc-context', () => ({
  getDb: h.getDb,
  sopCache: h.sopCache,
  wisdomBrainSync: h.wisdomBrainSync,
}));

vi.mock('../../electron/ipc/projects', () => ({
  PROJECTS_FILE: h.projectsFile,
}));

vi.mock('../../electron/capability-refs', () => ({
  loadCapabilityRefs: h.loadCapabilityRefs,
  saveCapabilityRefs: h.saveCapabilityRefs,
  defaultCapabilityRefsPath: () => `${h.homedir}/capability-refs.json`,
}));

import { runOrphanReconcile, stopOrphanReconcileTimer } from '../../electron/orphan-reconcile';

const DAY_MS = 24 * 60 * 60 * 1000;

function writeProjects(projects: Array<{ name: string; path: string }>): void {
  fs.mkdirSync(path.dirname(h.projectsFile), { recursive: true });
  fs.writeFileSync(h.projectsFile, JSON.stringify(projects, null, 2), 'utf-8');
}

function writeState(state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(h.stateFile), { recursive: true });
  fs.writeFileSync(h.stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(h.stateFile, 'utf-8')) as Record<string, unknown>;
}

function makeTrashFile(): void {
  fs.mkdirSync(h.trashDir, { recursive: true });
  fs.writeFileSync(path.join(h.trashDir, 'stale.json'), '{}', 'utf-8');
}

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(h.homedir, { recursive: true, force: true });
  // 默认空态：无项目、无残留、无宽限记录
  writeProjects([]);
  h.listActiveProjectIds.mockReturnValue([]);
  h.listSoftDeletedProjectIds.mockReturnValue([]);
  h.purgeExpiredSoftDeleted.mockReturnValue([]);
  h.loadCapabilityRefs.mockResolvedValue({ schemaVersion: 1, capabilities: {} });
  h.saveCapabilityRefs.mockResolvedValue(undefined);
  h.logOrphanCleanup.mockResolvedValue(undefined);
  h.ruleSync.getUnfilteredToolIds.mockReturnValue([]);
  h.ruleSync.getRuleDir.mockReturnValue('');
  h.ruleSync.removeRules.mockResolvedValue(undefined);
  h.sopCache.clearCache.mockResolvedValue(undefined);
  h.getDb.mockReturnValue({});
});

afterEach(() => {
  fs.rmSync(h.homedir, { recursive: true, force: true });
  stopOrphanReconcileTimer();
  vi.restoreAllMocks();
});

describe('runOrphanReconcile 空项目集宽限 + 全局重置', () => {
  it('空集 + 有残留 → 开始 7 天宽限记录，不执行重置', async () => {
    makeTrashFile();

    const report = await runOrphanReconcile();

    expect(report.cleanReset).toBeUndefined();
    expect(h.saveCapabilityRefs).not.toHaveBeenCalled();
    expect(h.purgeExpiredSoftDeleted).not.toHaveBeenCalledWith(h.getDb(), 0);
    // 宽限起点已持久化
    const state = readState();
    expect(typeof state.__orphan_empty_since__).toBe('number');
  });

  it('空集 + 无残留 → 不记录宽限起点', async () => {
    const report = await runOrphanReconcile();

    expect(report.cleanReset).toBeUndefined();
    const state = readState();
    expect(state.__orphan_empty_since__).toBeUndefined();
  });

  it('宽限未到期(<7天) → 不重置，保留起点', async () => {
    makeTrashFile();
    writeState({ __orphan_empty_since__: Date.now() - 1 * DAY_MS });

    const report = await runOrphanReconcile();

    expect(report.cleanReset).toBeUndefined();
    const state = readState();
    expect(typeof state.__orphan_empty_since__).toBe('number');
  });

  it('宽限到期(≥7天) + 有残留 → 全局重置并清除起点', async () => {
    makeTrashFile();
    writeState({ __orphan_empty_since__: Date.now() - 8 * DAY_MS });
    fs.mkdirSync(path.join(h.profilesDir, 'tool-eslint'), { recursive: true });
    h.ruleSync.getUnfilteredToolIds.mockReturnValue(['eslint']);
    h.ruleSync.getRuleDir.mockReturnValue(path.join(h.profilesDir, 'tool-eslint'));
    h.listSoftDeletedProjectIds.mockReturnValue(['stale-proj']);
    h.purgeExpiredSoftDeleted.mockReturnValue([{ table: 'scores', deleted: 3 }]);

    const report = await runOrphanReconcile();

    // 重置报告
    expect(report.cleanReset).toBeDefined();
    expect(report.cleanReset?.profilesTrashCleared).toBe(true);
    expect(report.cleanReset?.sopCacheCleared).toBe(true);
    expect(report.cleanReset?.removedTools).toEqual(['eslint']);
    expect(report.cleanReset?.capabilityRefsCleared).toBe(true);
    expect(report.cleanReset?.purged).toEqual([{ table: 'scores', deleted: 3 }]);
    // trash 目录物理删除
    expect(fs.existsSync(h.trashDir)).toBe(false);
    // SOP 缓存清除 + 工具规则删除
    expect(h.sopCache.clearCache).toHaveBeenCalled();
    expect(h.ruleSync.removeRules).toHaveBeenCalledWith('eslint');
    // 能力账本重置为空
    expect(h.saveCapabilityRefs).toHaveBeenCalledWith({ schemaVersion: 1, capabilities: {} });
    // DB 全部软删行强清（ttl=0）
    expect(h.purgeExpiredSoftDeleted).toHaveBeenCalledWith(h.getDb(), 0);
    // 审计
    expect(h.logOrphanCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'clean_reset' }),
    );
    // 宽限起点清除
    const state = readState();
    expect(state.__orphan_empty_since__).toBeUndefined();
  });

  it('宽限到期但无残留 → 仍执行全局重置', async () => {
    writeState({ __orphan_empty_since__: Date.now() - 8 * DAY_MS });

    const report = await runOrphanReconcile();

    expect(report.cleanReset).toBeDefined();
    const state = readState();
    expect(state.__orphan_empty_since__).toBeUndefined();
  });

  it('项目重加 → 取消宽限（清起点），不重置', async () => {
    writeProjects([{ name: 'demo', path: '/data/demo' }]);
    h.listActiveProjectIds.mockReturnValue(['/data/demo']);
    makeTrashFile();
    writeState({ __orphan_empty_since__: Date.now() - 8 * DAY_MS });

    const report = await runOrphanReconcile();

    expect(report.cleanReset).toBeUndefined();
    expect(h.saveCapabilityRefs).not.toHaveBeenCalled();
    expect(h.purgeExpiredSoftDeleted).not.toHaveBeenCalledWith(h.getDb(), 0);
    // 宽限起点已被清除，项目回加后不触发重置
    const state = readState();
    expect(state.__orphan_empty_since__).toBeUndefined();
  });

  it('getDb 抛错（无持久化模式）→ 降级空报告，不影响启动链', async () => {
    h.getDb.mockImplementation(() => {
      throw new Error('no persistent mode');
    });

    const report = await runOrphanReconcile();

    expect(report.activeProjectPaths).toEqual([]);
    expect(report.cleanReset).toBeUndefined();
  });
});
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WisdomBrainSync } from '../sop/sync/wisdom-brain-sync';
import type { ToolRuleSyncResult, ToolId } from '../sop/sync/tool-rule-sync';
import type { ExperienceRecord, ExperienceReportResult } from '../sop/sync/experience-reporter';

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

// WisdomBrainSync 支持注入子组件与 lockFilePath，故用 mock 子组件 + 真实 tmpdir 隔离测试。

function makeToolRuleSyncMock() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    syncTool: vi.fn(),
    setOnline: vi.fn(),
    getConfiguredToolIds: () => ['semgrep', 'trivy', 'eslint', 'dep-cruiser'],
  };
}

function makeExperienceReporterMock() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
    submitBatch: vi.fn().mockResolvedValue(undefined),
    flush: vi.fn().mockResolvedValue<ExperienceReportResult>({ sent: 0, queued: 0, failed: 0 }),
    setOnline: vi.fn(),
  };
}

function makeRecord(over: Partial<ExperienceRecord> = {}): ExperienceRecord {
  return {
    type: 'false_positive',
    ruleId: 'r-1',
    toolId: 'eslint',
    description: '误报',
    projectId: 'p-1',
    timestamp: new Date().toISOString(),
    ...over,
  };
}

describe('WisdomBrainSync', () => {
  let lockFile: string;
  let sync: WisdomBrainSync;
  let trs: ReturnType<typeof makeToolRuleSyncMock>;
  let er: ReturnType<typeof makeExperienceReporterMock>;

  beforeEach(() => {
    lockFile = path.join(
      os.tmpdir(),
      `zhshield-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    trs = makeToolRuleSyncMock();
    er = makeExperienceReporterMock();
    sync = new WisdomBrainSync({
      toolRuleSync: trs as never,
      experienceReporter: er as never,
      lockFilePath: lockFile,
    });
  });

  afterEach(() => {
    fs.rmSync(lockFile, { force: true });
  });

  // ─── 版本锁定 ───────────────────────────────────────────
  describe('版本锁定', () => {
    it('lockVersion 应记录并可通过 get/is 查询', () => {
      const lock = sync.lockVersion('eslint', '1.2.0', 'manual');
      expect(lock.lockedVersion).toBe('1.2.0');
      expect(lock.reason).toBe('manual');
      expect(lock.lockedAt).toMatch(ISO_DATE_PREFIX);
      expect(sync.isVersionLocked('eslint')).toBe(true);
      expect(sync.getVersionLock('eslint')?.lockedVersion).toBe('1.2.0');
    });

    it('unlockVersion 应移除锁并返回 true；未锁返回 false', () => {
      sync.lockVersion('trivy', '2.0');
      expect(sync.unlockVersion('trivy')).toBe(true);
      expect(sync.isVersionLocked('trivy')).toBe(false);
      expect(sync.unlockVersion('trivy')).toBe(false);
    });

    it('getLockedVersions 应返回全部锁', () => {
      sync.lockVersion('eslint', '1');
      sync.lockVersion('trivy', '2');
      expect(sync.getLockedVersions()).toHaveLength(2);
    });

    it('未锁工具 getVersionLock 应返回 undefined', () => {
      expect(sync.getVersionLock('semgrep')).toBeUndefined();
    });
  });

  // ─── 版本锁持久化 ───────────────────────────────────────
  describe('版本锁持久化', () => {
    it('saveLockedVersions 后 loadLockedVersions 应恢复', async () => {
      sync.lockVersion('eslint', '1.2.0', 'manual');
      await sync.saveLockedVersions();

      const reborn = new WisdomBrainSync({
        toolRuleSync: trs as never,
        experienceReporter: er as never,
        lockFilePath: lockFile,
      });
      await reborn.loadLockedVersions();
      expect(reborn.isVersionLocked('eslint')).toBe(true);
      expect(reborn.getVersionLock('eslint')?.lockedVersion).toBe('1.2.0');
    });

    it('lockFile 不存在时 loadLockedVersions 应清空且不抛错', async () => {
      const reborn = new WisdomBrainSync({
        toolRuleSync: trs as never,
        experienceReporter: er as never,
        lockFilePath: path.join(os.tmpdir(), `nope-${Date.now()}.json`),
      });
      await expect(reborn.loadLockedVersions()).resolves.toBeUndefined();
      expect(reborn.getLockedVersions()).toHaveLength(0);
    });
  });

  // ─── syncToolRules ──────────────────────────────────────
  describe('syncToolRules', () => {
    it('无锁时应原样返回同步结果', async () => {
      trs.syncTool.mockResolvedValue<ToolRuleSyncResult>({
        toolId: 'eslint',
        updated: true,
        fromVersion: '1.0',
        toVersion: '1.1',
      });
      const out = await sync.syncToolRules('eslint');
      expect(out.updated).toBe(true);
      expect(out.toVersion).toBe('1.1');
    });

    it('存在不同版本的锁时应覆盖为 updated:false / reason:write_error', async () => {
      sync.lockVersion('eslint', '1.1'); // 锁定在 1.1
      trs.syncTool.mockResolvedValue<ToolRuleSyncResult>({
        toolId: 'eslint',
        updated: true,
        fromVersion: '1.0',
        toVersion: '1.2',
      });
      const out = await sync.syncToolRules('eslint');
      expect(out.updated).toBe(false);
      expect(out.reason).toBe('write_error');
      expect(out.toVersion).toBe('1.2'); // 原始 toVersion 保留
    });

    it('锁版本与目标版本相同时不应覆盖', async () => {
      sync.lockVersion('eslint', '1.1');
      trs.syncTool.mockResolvedValue<ToolRuleSyncResult>({
        toolId: 'eslint',
        updated: true,
        fromVersion: '1.0',
        toVersion: '1.1',
      });
      const out = await sync.syncToolRules('eslint');
      expect(out.updated).toBe(true);
    });

    it('updated:false 时不应触发锁覆盖', async () => {
      sync.lockVersion('eslint', '9.9'); // 即便有锁
      trs.syncTool.mockResolvedValue<ToolRuleSyncResult>({
        toolId: 'eslint',
        updated: false,
        reason: 'already_latest',
      });
      const out = await sync.syncToolRules('eslint');
      expect(out.updated).toBe(false);
      expect(out.reason).toBe('already_latest');
    });
  });

  // ─── syncAllRules ───────────────────────────────────────
  describe('syncAllRules', () => {
    it('应遍历全部配置工具并返回结果数组', async () => {
      trs.syncTool.mockImplementation(async (id: ToolId) => ({
        toolId: id,
        updated: false,
        reason: 'already_latest',
      }));
      const results = await sync.syncAllRules();
      expect(results).toHaveLength(4);
      expect(results.map((r) => r.toolId).sort()).toEqual([
        'dep-cruiser',
        'eslint',
        'semgrep',
        'trivy',
      ]);
    });
  });

  // ─── 画像驱动工具下发（M4：按画像裁剪同步工具子集） ────────
  describe('画像驱动工具下发', () => {
    function makeScopedMock(toolIds: ToolId[]) {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        syncTool: vi.fn().mockImplementation(async (id: ToolId) => ({
          toolId: id,
          updated: false,
          reason: 'already_latest',
        })),
        setOnline: vi.fn(),
        getConfiguredToolIds: () => toolIds,
      };
    }

    it('无画像时全量下发全部配置工具', async () => {
      const scoped = makeScopedMock(['semgrep', 'trivy', 'eslint', 'dep-cruiser']);
      const s = new WisdomBrainSync({
        toolRuleSync: scoped as never,
        experienceReporter: er as never,
        lockFilePath: lockFile,
      });
      const results = await s.syncAllRules();
      expect(results.map((r) => r.toolId).sort()).toEqual([
        'dep-cruiser',
        'eslint',
        'semgrep',
        'trivy',
      ]);
    });

    it('go 画像仅下发 security 工具（semgrep/trivy 恒含，eslint/dep-cruiser 裁剪）', async () => {
      const scoped = makeScopedMock(['semgrep', 'trivy', 'eslint', 'dep-cruiser']);
      const s = new WisdomBrainSync({
        toolRuleSync: scoped as never,
        experienceReporter: er as never,
        lockFilePath: lockFile,
      });
      const results = await s.syncAllRules({ language: 'go', features: [] });
      expect(results.map((r) => r.toolId).sort()).toEqual(['semgrep', 'trivy']);
    });

    it('typescript 画像下发全部工具（eslint/dep-cruiser 命中）', async () => {
      const scoped = makeScopedMock(['semgrep', 'trivy', 'eslint', 'dep-cruiser']);
      const s = new WisdomBrainSync({
        toolRuleSync: scoped as never,
        experienceReporter: er as never,
        lockFilePath: lockFile,
      });
      const results = await s.syncAllRules({ language: 'typescript', features: [] });
      expect(results.map((r) => r.toolId).sort()).toEqual([
        'dep-cruiser',
        'eslint',
        'semgrep',
        'trivy',
      ]);
    });

    it('syncAll 透传 feature 至规则同步', async () => {
      const scoped = makeScopedMock(['semgrep', 'trivy', 'eslint', 'dep-cruiser']);
      const s = new WisdomBrainSync({
        toolRuleSync: scoped as never,
        experienceReporter: er as never,
        lockFilePath: lockFile,
      });
      const r = await s.syncAll({ feature: { language: 'go', features: [] } });
      expect(r.ruleSyncResults.map((x) => x.toolId).sort()).toEqual(['semgrep', 'trivy']);
    });
  });

  // ─── 经验回写 ───────────────────────────────────────────
  describe('经验回写', () => {
    it('syncExperience 应逐条 submit 后 flush', async () => {
      er.flush.mockResolvedValue({ sent: 2, queued: 0, failed: 0 });
      const r = await sync.syncExperience([makeRecord(), makeRecord()]);
      expect(er.submit).toHaveBeenCalledTimes(2);
      expect(er.flush).toHaveBeenCalledTimes(1);
      expect(r.sent).toBe(2);
    });

    it('syncExperienceBatch 应批量 submitBatch 后 flush', async () => {
      er.flush.mockResolvedValue({ sent: 3, queued: 0, failed: 0 });
      const r = await sync.syncExperienceBatch([makeRecord(), makeRecord(), makeRecord()]);
      expect(er.submitBatch).toHaveBeenCalledTimes(1);
      expect(er.flush).toHaveBeenCalledTimes(1);
      expect(r.sent).toBe(3);
    });
  });

  // ─── syncAll ────────────────────────────────────────────
  describe('syncAll', () => {
    it('无 experiences 时 experienceResult 应为 null', async () => {
      trs.syncTool.mockResolvedValue({
        toolId: 'eslint',
        updated: false,
        reason: 'already_latest',
      });
      const r = await sync.syncAll();
      expect(r.experienceResult).toBeNull();
      expect(r.ruleSyncResults).toHaveLength(4);
      expect(r.lockedVersions).toEqual([]);
    });

    it('带 experiences 时应回写并返回 experienceResult', async () => {
      trs.syncTool.mockResolvedValue({
        toolId: 'eslint',
        updated: false,
        reason: 'already_latest',
      });
      er.flush.mockResolvedValue({ sent: 1, queued: 0, failed: 0 });
      const r = await sync.syncAll({ experiences: [makeRecord()] });
      expect(r.experienceResult?.sent).toBe(1);
    });
  });

  // ─── 状态与访问器 ───────────────────────────────────────
  describe('状态与访问器', () => {
    it('setOnline 应委托给两个子组件', () => {
      sync.setOnline(false);
      expect(trs.setOnline).toHaveBeenCalledWith(false);
      expect(er.setOnline).toHaveBeenCalledWith(false);
    });

    it('getRuleSync / getExperienceReporter 应返回注入实例', () => {
      expect(sync.getRuleSync()).toBe(trs);
      expect(sync.getExperienceReporter()).toBe(er);
    });
  });

  // ─── initialize ─────────────────────────────────────────
  describe('initialize', () => {
    it('应初始化子组件并加载版本锁', async () => {
      await sync.initialize();
      expect(trs.initialize).toHaveBeenCalledTimes(1);
      expect(er.initialize).toHaveBeenCalledTimes(1);
    });
  });
});

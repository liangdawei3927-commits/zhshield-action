import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WisdomBrainSync } from '../sop/sync/wisdom-brain-sync';
import {
  ToolRuleSync,
  buildDefaultToolRuleConfigs,
  EXPIRY_THRESHOLD_DAYS,
} from '../sop/sync/tool-rule-sync';
import type { ToolRuleSyncResult, ToolId, ToolRuleVersion } from '../sop/sync/tool-rule-sync';
import { getReclaimingToolRuleSinces } from '../sop/sync/capability-refs-reader';
import type { ExperienceRecord, ExperienceReportResult } from '../sop/sync/experience-reporter';

// 竞态测试需要拦截 getReclaimingToolRuleSinces 的两次读取（初扫 vs 删除前重读），
// 默认实现委托真实函数，其余测试行为不变。
vi.mock('../sop/sync/capability-refs-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sop/sync/capability-refs-reader')>();
  return {
    ...actual,
    getReclaimingToolRuleSinces: vi.fn(actual.getReclaimingToolRuleSinces),
  };
});

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

  // ─── getInScopeToolIds ──────────────────────────────────
  describe('getInScopeToolIds', () => {
    it('无 feature 时返回全部配置工具', () => {
      expect(sync.getInScopeToolIds()).toEqual(['semgrep', 'trivy', 'eslint', 'dep-cruiser']);
    });

    it('go 画像按 isToolInScope 裁剪为 security 工具', () => {
      expect(sync.getInScopeToolIds({ language: 'go', features: [] })).toEqual([
        'semgrep',
        'trivy',
      ]);
    });

    it('typescript 画像保留全部工具', () => {
      expect(sync.getInScopeToolIds({ language: 'typescript', features: [] })).toEqual([
        'semgrep',
        'trivy',
        'eslint',
        'dep-cruiser',
      ]);
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

  // ─── scanAndRemoveExpired（R3 到期物理删除） ──────────────
  describe('scanAndRemoveExpired', () => {
    let expiryTmpDir: string;
    let expirySync: WisdomBrainSync;
    let expiryTrs: ToolRuleSync;

    beforeEach(() => {
      expiryTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-wbs-expiry-'));
      expiryTrs = new ToolRuleSync(
        buildDefaultToolRuleConfigs('http://localhost:3010/api/v1'),
        expiryTmpDir,
      );
      expirySync = new WisdomBrainSync({
        toolRuleSync: expiryTrs,
        experienceReporter: er as never,
        lockFilePath: path.join(expiryTmpDir, 'version-locks.json'),
      });
    });

    afterEach(() => {
      fs.rmSync(expiryTmpDir, { recursive: true, force: true });
    });

    function writeLedger(entries: Record<string, unknown>): void {
      fs.writeFileSync(
        path.join(expiryTmpDir, 'capability-refs.json'),
        JSON.stringify({ schemaVersion: 1, capabilities: entries }),
        'utf-8',
      );
    }

    function writeVersions(versions: ToolRuleVersion[]): void {
      fs.writeFileSync(
        path.join(expiryTmpDir, 'tool-rule-versions.json'),
        JSON.stringify(versions),
        'utf-8',
      );
    }

    it('reclaiming 且 since 8 天前 → 物理删除并返回 toolId', async () => {
      writeVersions([
        {
          toolId: 'eslint',
          version: '1.0.0',
          hash: 'h1',
          size: 1,
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          toolId: 'trivy',
          version: '2.0.0',
          hash: 'h2',
          size: 2,
          publishedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      await expiryTrs.initialize();
      fs.writeFileSync(path.join(expiryTmpDir, 'eslint-rules', 'rule.json'), '{}', 'utf-8');
      writeLedger({
        'toolrule:eslint': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: Date.now() - 8 * 24 * 60 * 60 * 1000,
        },
      });

      const removed = await expirySync.scanAndRemoveExpired();

      expect(removed).toEqual(['eslint']);
      expect(fs.existsSync(path.join(expiryTmpDir, 'eslint-rules'))).toBe(false);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(expiryTmpDir, 'tool-rule-versions.json'), 'utf-8'),
      ) as ToolRuleVersion[];
      expect(persisted.map((v) => v.toolId)).toEqual(['trivy']);
    });

    it('reclaiming 且 since 1 小时前（窗口内）→ 不删', async () => {
      await expiryTrs.initialize();
      fs.mkdirSync(path.join(expiryTmpDir, 'eslint-rules'), { recursive: true });
      writeLedger({
        'toolrule:eslint': {
          languages: [],
          refs: [],
          status: 'reclaiming',
          since: Date.now() - 60 * 60 * 1000,
        },
      });

      const removed = await expirySync.scanAndRemoveExpired();

      expect(removed).toEqual([]);
      expect(fs.existsSync(path.join(expiryTmpDir, 'eslint-rules'))).toBe(true);
    });

    it('since 恰为 7 天整 → 不删（严格大于）', async () => {
      await expiryTrs.initialize();
      fs.mkdirSync(path.join(expiryTmpDir, 'eslint-rules'), { recursive: true });
      vi.useFakeTimers();
      try {
        const now = Date.now();
        const thresholdMs = EXPIRY_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
        writeLedger({
          'toolrule:eslint': {
            languages: [],
            refs: [],
            status: 'reclaiming',
            since: now - thresholdMs,
          },
        });
        const removed = await expirySync.scanAndRemoveExpired();
        expect(removed).toEqual([]);
        expect(fs.existsSync(path.join(expiryTmpDir, 'eslint-rules'))).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('竞态：扫描后、删除前被唤醒 → 不删', async () => {
      await expiryTrs.initialize();
      fs.mkdirSync(path.join(expiryTmpDir, 'eslint-rules'), { recursive: true });
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      vi.mocked(getReclaimingToolRuleSinces)
        .mockImplementationOnce(() => new Map([['eslint', eightDaysAgo]]))
        .mockImplementationOnce(() => new Map()); // 重读：已被唤醒（active / since 清除）

      const removed = await expirySync.scanAndRemoveExpired();

      expect(removed).toEqual([]);
      expect(fs.existsSync(path.join(expiryTmpDir, 'eslint-rules'))).toBe(true);
    });

    it('initialize 内调用 scanAndRemoveExpired 不抛', async () => {
      await expect(expirySync.initialize()).resolves.toBeUndefined();
    });
  });
});

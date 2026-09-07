import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRuleSync, buildDefaultToolRuleConfigs } from '../sop/sync/tool-rule-sync';
import type { ToolId, ToolRuleVersion } from '../sop/sync/tool-rule-sync';

describe('ToolRuleSync remote tool filtering', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-trs-filter-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSync(): ToolRuleSync {
    const configs = buildDefaultToolRuleConfigs('http://localhost:3010/api/v1').map((c) => ({
      ...c,
      localDir: path.join(tmpDir, c.localDir),
    }));
    return new ToolRuleSync(configs);
  }

  it('getConfiguredToolIds returns all 4 tools when no remote filter set', () => {
    const sync = makeSync();
    const ids = sync.getConfiguredToolIds();
    expect(ids.sort()).toEqual(['dep-cruiser', 'eslint', 'semgrep', 'trivy']);
  });

  it('setRemoteToolIds(null) restores full set', () => {
    const sync = makeSync();
    sync.setRemoteToolIds(['semgrep', 'trivy'] as ToolId[]);
    expect(sync.getConfiguredToolIds().sort()).toEqual(['semgrep', 'trivy']);
    sync.setRemoteToolIds(null);
    expect(sync.getConfiguredToolIds().sort()).toEqual([
      'dep-cruiser',
      'eslint',
      'semgrep',
      'trivy',
    ]);
  });

  it('remote list filters to intersection with configured tools', () => {
    const sync = makeSync();
    sync.setRemoteToolIds(['semgrep', 'trivy'] as ToolId[]);
    const ids = sync.getConfiguredToolIds();
    expect(ids.sort()).toEqual(['semgrep', 'trivy']);
  });

  it('remote list with unknown tools only returns configured ones', () => {
    const sync = makeSync();
    sync.setRemoteToolIds(['semgrep', 'unknown-tool'] as ToolId[]);
    const ids = sync.getConfiguredToolIds();
    expect(ids).toEqual(['semgrep']);
  });

  it('empty remote list means no tools active', () => {
    const sync = makeSync();
    sync.setRemoteToolIds([]);
    expect(sync.getConfiguredToolIds()).toEqual([]);
  });

  it('getRemoteToolIds returns the set value', () => {
    const sync = makeSync();
    expect(sync.getRemoteToolIds()).toBeNull();
    sync.setRemoteToolIds(['eslint'] as ToolId[]);
    expect(sync.getRemoteToolIds()).toEqual(['eslint']);
  });
});

describe('ToolRuleSync syncAll with remote filter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-trs-syncall-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('syncAll only syncs active tools when remote filter set', async () => {
    const configs = buildDefaultToolRuleConfigs('http://localhost:3010/api/v1').map((c) => ({
      ...c,
      localDir: path.join(tmpDir, c.localDir),
    }));
    const sync = new ToolRuleSync(configs);
    await sync.initialize();
    sync.setRemoteToolIds(['eslint'] as ToolId[]);

    const results = await sync.syncAll();
    expect(results).toHaveLength(1);
    expect(results[0].toolId).toBe('eslint');
  });

  it('syncAll syncs all tools when remote filter is null', async () => {
    const configs = buildDefaultToolRuleConfigs('http://localhost:3010/api/v1').map((c) => ({
      ...c,
      localDir: path.join(tmpDir, c.localDir),
    }));
    const sync = new ToolRuleSync(configs);
    await sync.initialize();

    const results = await sync.syncAll();
    expect(results).toHaveLength(4);
  });
});

describe('ToolRuleSync reclaiming capability filter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-trs-reclaim-'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSync(): ToolRuleSync {
    const configs = buildDefaultToolRuleConfigs('http://localhost:3010/api/v1').map((c) => ({
      ...c,
      localDir: path.join(tmpDir, c.localDir),
    }));
    return new ToolRuleSync(configs, tmpDir);
  }

  function writeReclaiming(toolIds: ToolId[]): void {
    const capabilities: Record<string, unknown> = {};
    for (const id of toolIds) {
      capabilities[`toolrule:${id}`] = {
        languages: [],
        refs: [],
        status: 'reclaiming',
        since: 1759747200000,
      };
    }
    fs.writeFileSync(
      path.join(tmpDir, 'capability-refs.json'),
      JSON.stringify({ schemaVersion: 1, capabilities }),
      'utf-8',
    );
  }

  it('getConfiguredToolIds excludes reclaiming tools, keeps others', () => {
    writeReclaiming(['eslint']);
    const sync = makeSync();
    expect(sync.getConfiguredToolIds().sort()).toEqual(['dep-cruiser', 'semgrep', 'trivy']);
  });

  it('getRefsFilteredActiveTools also excludes reclaiming tools', () => {
    writeReclaiming(['eslint', 'trivy']);
    const sync = makeSync();
    expect(sync.getRefsFilteredActiveTools().sort()).toEqual(['dep-cruiser', 'semgrep']);
  });

  it('getUnfilteredToolIds returns reclaiming tools too（领取唤醒路径可用）', () => {
    writeReclaiming(['eslint']);
    const sync = makeSync();
    sync.setRemoteToolIds(['eslint', 'semgrep'] as ToolId[]);
    // 运行层（getConfiguredToolIds）剔 reclaiming → 不含 eslint
    expect(sync.getConfiguredToolIds().sort()).toEqual(['semgrep']);
    // 领取层（getUnfilteredToolIds，claim 唤醒用）→ eslint 仍在
    expect(sync.getUnfilteredToolIds().sort()).toEqual(['eslint', 'semgrep']);
  });

  it('getUnfilteredToolIds 无远程白名单 → 全量配置（离线降级一致）', () => {
    writeReclaiming(['eslint']);
    const sync = makeSync();
    expect(sync.getUnfilteredToolIds().sort()).toEqual([
      'dep-cruiser',
      'eslint',
      'semgrep',
      'trivy',
    ]);
  });

  it('reclaiming exclusion stacks with remote intersection', () => {
    writeReclaiming(['eslint']);
    const sync = makeSync();
    sync.setRemoteToolIds(['eslint', 'semgrep', 'trivy'] as ToolId[]);
    expect(sync.getConfiguredToolIds().sort()).toEqual(['semgrep', 'trivy']);
  });

  it('no capability-refs.json means no exclusion', () => {
    const sync = makeSync();
    expect(sync.getConfiguredToolIds().sort()).toEqual([
      'dep-cruiser',
      'eslint',
      'semgrep',
      'trivy',
    ]);
  });

  it('wake-up reclaims tool and resync returns already_latest without download', async () => {
    writeReclaiming(['eslint']);
    const version: ToolRuleVersion = {
      toolId: 'eslint',
      version: '1.0.0',
      hash: 'abc123',
      size: 0,
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(
      path.join(tmpDir, 'tool-rule-versions.json'),
      JSON.stringify([version]),
      'utf-8',
    );
    const sync = makeSync();
    await sync.initialize();

    // reclaiming 剔除生效
    expect(sync.getConfiguredToolIds().sort()).toEqual(['dep-cruiser', 'semgrep', 'trivy']);

    // 唤醒：账本重写为不含 eslint 的 reclaiming 标记
    writeReclaiming([]);
    expect(sync.getConfiguredToolIds().sort()).toEqual([
      'dep-cruiser',
      'eslint',
      'semgrep',
      'trivy',
    ]);

    // 零重下载：远端版本与本地缓存一致 → already_latest，不触发 download
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => version,
    });

    const result = await sync.syncTool('eslint');
    expect(result).toEqual({ toolId: 'eslint', updated: false, reason: 'already_latest' });
    const downloadCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/download'),
    );
    expect(downloadCalls).toHaveLength(0);
  });
});

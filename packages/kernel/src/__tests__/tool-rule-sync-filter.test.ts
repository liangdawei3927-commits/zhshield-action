import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRuleSync, buildDefaultToolRuleConfigs } from '../sop/sync/tool-rule-sync';
import type { ToolId } from '../sop/sync/tool-rule-sync';

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

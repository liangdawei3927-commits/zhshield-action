import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRuleSync, buildDefaultToolRuleConfigs } from '../sop/sync/tool-rule-sync';
import type { ToolId, ToolRuleVersion } from '../sop/sync/tool-rule-sync';

describe('ToolRuleSync removeRules', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhshield-trs-expiry-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSync(): ToolRuleSync {
    return new ToolRuleSync(buildDefaultToolRuleConfigs('http://localhost:3010/api/v1'), tmpDir);
  }

  function makeVersion(toolId: ToolId, version: string): ToolRuleVersion {
    return {
      toolId,
      version,
      hash: `hash-${toolId}`,
      size: 1,
      publishedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('removeRules 删除规则目录、版本文件条目与内存缓存', async () => {
    const sync = makeSync();
    fs.writeFileSync(
      path.join(tmpDir, 'tool-rule-versions.json'),
      JSON.stringify([makeVersion('eslint', '1.0.0'), makeVersion('trivy', '2.0.0')]),
      'utf-8',
    );
    await sync.initialize();
    fs.writeFileSync(path.join(tmpDir, 'eslint-rules', 'rule.json'), '{}', 'utf-8');
    expect(sync.getLocalVersion('eslint')).toBeDefined();

    await sync.removeRules('eslint');

    expect(fs.existsSync(path.join(tmpDir, 'eslint-rules'))).toBe(false);
    expect(sync.getLocalVersion('eslint')).toBeUndefined();
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'tool-rule-versions.json'), 'utf-8'),
    ) as ToolRuleVersion[];
    expect(persisted.map((v) => v.toolId)).toEqual(['trivy']);
  });

  it('removeRules 幂等：目录已不存在时再次调用不抛', async () => {
    const sync = makeSync();
    await sync.initialize();
    await sync.removeRules('eslint');
    await expect(sync.removeRules('eslint')).resolves.toBeUndefined();
  });

  it('removeRules 对未配置的 toolId 不抛', async () => {
    const configs = buildDefaultToolRuleConfigs('http://localhost:3010/api/v1').filter(
      (c) => c.toolId !== 'eslint',
    );
    const sync = new ToolRuleSync(configs, tmpDir);
    await sync.initialize();
    await expect(sync.removeRules('eslint')).resolves.toBeUndefined();
  });

  it('removeRules 不触碰 capability-refs.json', async () => {
    const sync = makeSync();
    await sync.initialize();
    fs.writeFileSync(
      path.join(tmpDir, 'capability-refs.json'),
      JSON.stringify({ schemaVersion: 1, capabilities: {} }),
      'utf-8',
    );
    await sync.removeRules('eslint');
    const ledger = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'capability-refs.json'), 'utf-8'),
    ) as { schemaVersion: number };
    expect(ledger.schemaVersion).toBe(1);
  });
});
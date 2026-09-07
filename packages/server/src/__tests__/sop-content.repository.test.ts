import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbConnection, saveRuleContent, saveToolPackage } from '@zh/db';
import { computeRuleContentSha, hashToolRuleFiles } from '@zh/kernel';
import type { SopRule, ToolRuleFile } from '@zh/kernel';
import { resolveMigrationsDir, TenancyService } from '../tenancy/tenancy.service';
import { SopContentRepository } from '../sop/sop-content.repository';
import { ToolRuleController } from '../sop/tool-rule.controller';
import { ToolRuleStore } from '../sop/tool-rule-store';
import { ToolRuleLoader } from '../sop/tool-rule-loader';

const STATIC_TOOLS = ['semgrep', 'trivy', 'eslint', 'dep-cruiser'] as const;
const FIXTURE_FILES: ToolRuleFile[] = [
  { filename: 'rules/fixture.yml', content: 'fixture-pack-content' },
];

// packages/server/src/__tests__ → 仓库根
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_PACKS_DIR = join(REPO_ROOT, 'packages', 'kernel', 'test-fixtures', 'sop-content', 'tool-packs');

function makeRule(id: string, status: SopRule['status'] = 'active'): SopRule {
  return {
    id,
    name: `fixture-${id}`,
    domain: 'security',
    action: 'scan',
    source: 'official',
    description: 'C3 fixture rule',
    status,
    executionMode: 'async',
    severity: 'high',
    applicableEngines: ['semgrep'],
    content: { rule: id },
    tags: ['fixture'],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}

function seedDb(dbPath: string): void {
  const conn = new DbConnection({ dbPath, walMode: true });
  conn.connect();
  conn.migrate(resolveMigrationsDir());
  const db = conn.getDb();

  const active = makeRule('security.scan.official.fixture-active');
  const disabled = makeRule('security.scan.official.fixture-disabled', 'disabled');
  for (const rule of [active, disabled]) {
    saveRuleContent(db, {
      id: rule.id,
      ruleId: rule.id,
      domain: rule.domain,
      action: rule.action,
      source: rule.source,
      name: rule.name,
      description: rule.description,
      severity: rule.severity,
      status: rule.status,
      executionMode: rule.executionMode,
      tags: rule.tags,
      applicableEngines: rule.applicableEngines,
      content: JSON.stringify(rule),
      contentSha: computeRuleContentSha(rule),
      version: '1.0.0',
    });
  }

  const sha256 = hashToolRuleFiles(FIXTURE_FILES);
  saveToolPackage(db, {
    id: 'tp-semgrep',
    toolId: 'semgrep',
    version: `1.${sha256.slice(0, 12)}`,
    sha256,
    filesJson: JSON.stringify(FIXTURE_FILES),
    languages: ['typescript'],
    status: 'active',
  });

  conn.close();
}

describe('SopContentRepository（C3 服务端读库 + 故障降级）', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'zh-sop-content-'));
    dbPath = join(dir, 'test.db');
    process.env.ZH_SERVER_DB = dbPath;
    seedDb(dbPath);
  });

  afterEach(() => {
    delete process.env.ZH_SERVER_DB;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('getAllRules 只返回非禁用规则，且 Date 字段复活为 Date 实例', () => {
    const repo = new SopContentRepository();
    const rules = repo.getAllRules();
    expect(rules).not.toBeNull();
    expect(rules!.map((r) => r.id)).toEqual(['security.scan.official.fixture-active']);
    expect(rules![0]!.createdAt).toBeInstanceOf(Date);
    expect(rules![0]!.createdAt.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(rules![0]!.updatedAt).toBeInstanceOf(Date);
  });

  it('listActiveToolPacks 解析 files_json 为 {filename, content} 契约', () => {
    const repo = new SopContentRepository();
    const packs = repo.listActiveToolPacks();
    expect(packs).not.toBeNull();
    expect(packs!.map((p) => p.toolId)).toEqual(['semgrep']);
    expect(packs![0]!.files).toEqual(FIXTURE_FILES);
    expect(packs![0]!.sha256).toBe(hashToolRuleFiles(FIXTURE_FILES));
  });

  it('controller 优先从 DB 提供工具包（命中库内 fixture 而非真实 tool-packs）', () => {
    const repo = new SopContentRepository();
    const ctrl = new ToolRuleController(new ToolRuleStore(new ToolRuleLoader(FIXTURE_PACKS_DIR), repo));
    const files = ctrl.getRules('semgrep');
    expect(files).toEqual(FIXTURE_FILES);
    expect(ctrl.getVersion('semgrep').hash).toBe(hashToolRuleFiles(files));
  });

  it('DB 不可用（父路径为文件）：仓库返回 null，controller 降级文件系统 loader', () => {
    // DbConnection.connect 会递归创建缺失目录，故不能用"目录不存在"模拟不可用；
    // 用"父路径为普通文件"让 better-sqlite3 打开失败（unable to open database file）。
    writeFileSync(join(dir, 'blocked'), 'blocker');
    process.env.ZH_SERVER_DB = join(dir, 'blocked', 'no.db');
    const repo = new SopContentRepository();
    expect(repo.getAllRules()).toBeNull();
    expect(repo.listActiveToolPacks()).toBeNull();

    const ctrl = new ToolRuleController(new ToolRuleStore(new ToolRuleLoader(FIXTURE_PACKS_DIR), repo));
    const files = ctrl.getRules('semgrep');
    expect(files.length).toBeGreaterThan(0);
  });

  it('resolveTools 优先读 tool_package（DB 种子唯一工具 semgrep，含 languages），空表不可用时回退静态全集', () => {
    // 库内只有 semgrep → DB 清单优先生效，覆盖静态全集种子；languages 透出 tool_package 列
    const tenancy = new TenancyService();
    expect(tenancy.resolveTools(STATIC_TOOLS, undefined)).toEqual([
      { toolId: 'semgrep', languages: ['typescript'] },
    ]);

    // DB 不可用 → 回退静态全集，languages 恒空数组
    writeFileSync(join(dir, 'blocked'), 'blocker');
    process.env.ZH_SERVER_DB = join(dir, 'blocked', 'no.db');
    const degraded = new TenancyService();
    expect(degraded.resolveTools(STATIC_TOOLS, undefined)).toEqual(
      STATIC_TOOLS.map((toolId) => ({ toolId, languages: [] })),
    );
    degraded.onModuleDestroy();
  });
});
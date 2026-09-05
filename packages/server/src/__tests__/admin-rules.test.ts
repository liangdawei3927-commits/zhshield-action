import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbConnection } from '@zh/db';
import { computeRuleContentSha } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';
import { resolveMigrationsDir } from '../tenancy/tenancy.service';
import { SopContentAdminRepository } from '../sop/sop-content-admin.repository';
import { SopService } from '../sop/sop.service';
import { ToolRuleStore } from '../sop/tool-rule-store';
import { ToolRuleLoader } from '../sop/tool-rule-loader';
import { AdminService } from '../admin/admin.service';

function makeRule(id: string, status: SopRule['status'] = 'draft'): SopRule {
  return {
    id,
    name: `admin-${id}`,
    domain: 'security',
    action: 'scan',
    source: 'official',
    description: 'C4 admin fixture rule',
    status,
    executionMode: 'async',
    severity: 'high',
    applicableEngines: ['semgrep'],
    content: { rule: id },
    tags: ['admin-fixture'],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}

describe('AdminService 规则管理（C4 写路径 + 读路径刷新）', () => {
  let dir: string;
  let dbPath: string;
  let adminRepo: SopContentAdminRepository;
  let sopService: SopService;
  let admin: AdminService;
  let db: ReturnType<DbConnection['getDb']>;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'zh-admin-rules-'));
    dbPath = join(dir, 'test.db');
    process.env.ZH_SERVER_DB = dbPath;

    adminRepo = new SopContentAdminRepository();
    sopService = new SopService(adminRepo);
    const toolStore = new ToolRuleStore(new ToolRuleLoader(), adminRepo);
    admin = new AdminService(adminRepo, sopService, toolStore);

    const conn = new DbConnection({ dbPath, walMode: true });
    conn.connect();
    conn.migrate(resolveMigrationsDir());
    db = conn.getDb();
  });

  afterEach(() => {
    delete process.env.ZH_SERVER_DB;
    adminRepo.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('saveRule 创建规则：version=1.0.0、content_sha=H1、审计 create', async () => {
    const rule = makeRule('security.scan.official.admin-create');
    const { created } = await admin.saveRule(rule);
    expect(created).toBe(true);

    const row = db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(rule.id) as {
      version: string;
      status: string;
      content_sha: string;
    };
    expect(row.version).toBe('1.0.0');
    expect(row.status).toBe('draft');
    expect(row.content_sha).toBe(computeRuleContentSha(rule));

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = ? AND action = 'create'")
      .get(rule.id);
    expect(audit).toBeDefined();
    expect((audit as { operator: string }).operator).toBe('admin');
  });

  it('saveRule 更新已存在规则：status 强制 draft、version 保留、审计 update', async () => {
    const rule = makeRule('security.scan.official.admin-update');
    await admin.saveRule(rule);
    const updated = { ...rule, description: 'updated description', status: 'active' as const };
    const { created } = await admin.saveRule(updated);
    expect(created).toBe(false);

    const row = db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(rule.id) as {
      status: string;
      version: string;
      description: string;
    };
    expect(row.status).toBe('draft');
    expect(row.version).toBe('1.0.0');
    expect(row.description).toBe('updated description');

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = ? AND action = 'update'")
      .get(rule.id);
    expect(audit).toBeDefined();
  });

  it('publishRule：draft → active、版本 1.0.0→1.0.1、历史快照、rule_scope 平台行(org_id NULL)、审计 publish', async () => {
    const rule = makeRule('security.scan.official.admin-publish');
    await admin.saveRule(rule);
    await admin.publishRule(rule.id);

    const row = db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(rule.id) as {
      status: string;
      version: string;
    };
    expect(row.status).toBe('active');
    expect(row.version).toBe('1.0.1');

    const history = db
      .prepare('SELECT * FROM rule_content_version WHERE rule_id = ?')
      .all(rule.id) as Array<{ version: string }>;
    expect(history).toHaveLength(1);
    expect(history[0]!.version).toBe('1.0.0');

    const scope = db.prepare('SELECT * FROM rule_scope WHERE rule_id = ?').get(rule.id) as {
      org_id: string | null;
      version: string;
      source: string;
    };
    expect(scope.org_id).toBeNull();
    expect(scope.version).toBe('1.0.1');
    expect(scope.source).toBe('manual');

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = ? AND action = 'publish'")
      .get(rule.id);
    expect(audit).toBeDefined();
  });

  it('publishRule 二次发布幂等：scope 平台行仅 1 行且版本为第二次发布', async () => {
    const rule = makeRule('security.scan.official.admin-publish-twice');
    await admin.saveRule(rule);
    await admin.publishRule(rule.id);
    await admin.saveRule(rule);
    await admin.publishRule(rule.id);

    const rows = db
      .prepare('SELECT version FROM rule_scope WHERE rule_id = ?')
      .all(rule.id) as Array<{ version: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe('1.0.2');
  });

  it('publishRule 非 draft/trial 状态 → 400 BadRequestException', async () => {
    const rule = makeRule('security.scan.official.admin-pub-invalid', 'active');
    await admin.saveRule(rule);
    await expect(admin.publishRule(rule.id)).rejects.toThrow(BadRequestException);
  });

  it('rollbackRule：从历史快照恢复 content/version、同步 rule_scope 平台行、审计 rollback', async () => {
    const rule = makeRule('security.scan.official.admin-rollback');
    await admin.saveRule(rule);
    await admin.publishRule(rule.id);
    await admin.rollbackRule(rule.id, '1.0.0');

    const row = db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(rule.id) as {
      version: string;
      status: string;
      content_sha: string;
    };
    expect(row.version).toBe('1.0.0');
    expect(row.status).toBe('active');

    const scope = db
      .prepare('SELECT org_id, version, enabled, content_sha FROM rule_scope WHERE rule_id = ?')
      .get(rule.id) as { org_id: string | null; version: string; enabled: number; content_sha: string };
    expect(scope.org_id).toBeNull();
    expect(scope.version).toBe('1.0.0');
    expect(scope.enabled).toBe(1);
    expect(scope.content_sha).toBe(row.content_sha);

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = ? AND action = 'rollback'")
      .get(rule.id);
    expect(audit).toBeDefined();
  });

  it('setRuleStatus：draft → trial 生效并审计', async () => {
    const rule = makeRule('security.scan.official.admin-status');
    await admin.saveRule(rule);
    await admin.setRuleStatus(rule.id, 'trial');
    const row = db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(rule.id) as {
      status: string;
    };
    expect(row.status).toBe('trial');
  });

  it('deleteRule：软删为 deprecated + rule_scope 下架（enabled=0）、审计 delete', async () => {
    const rule = makeRule('security.scan.official.admin-delete');
    await admin.saveRule(rule);
    await admin.deleteRule(rule.id);
    const row = db.prepare('SELECT * FROM rule_content WHERE rule_id = ?').get(rule.id) as {
      status: string;
    };
    expect(row.status).toBe('deprecated');
    const scope = db
      .prepare('SELECT enabled FROM rule_scope WHERE rule_id = ?')
      .get(rule.id) as { enabled: number };
    expect(scope.enabled).toBe(0);
    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = ? AND action = 'delete'")
      .get(rule.id);
    expect(audit).toBeDefined();
  });

  it('写路径后 registry 立即刷新：SopService.getAllRules 可见新规则', async () => {
    const rule = makeRule('security.scan.official.admin-registry');
    await admin.saveRule(rule);
    const ids = sopService.getAllRules().map((r) => r.id);
    expect(ids).toContain(rule.id);
  });

  it('不存在的规则 publish → 404 NotFoundException', async () => {
    await expect(admin.publishRule('security.scan.official.nope')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('规则内容超过 100KB → 400 BadRequestException', async () => {
    const big = makeRule('security.scan.official.admin-big');
    big.content = { blob: 'x'.repeat(100 * 1024) };
    await expect(admin.saveRule(big)).rejects.toThrow(BadRequestException);
  });

  it('DB 不可用 → 503 ServiceUnavailableException', async () => {
    writeFileSync(join(dir, 'blocked'), 'blocker');
    process.env.ZH_SERVER_DB = join(dir, 'blocked', 'no.db');
    const brokenRepo = new SopContentAdminRepository();
    const brokenService = new SopService(brokenRepo);
    const brokenStore = new ToolRuleStore(new ToolRuleLoader(), brokenRepo);
    const brokenAdmin = new AdminService(brokenRepo, brokenService, brokenStore);
    await expect(
      brokenAdmin.saveRule(makeRule('security.scan.official.admin-unavailable')),
    ).rejects.toThrow(ServiceUnavailableException);
    brokenRepo.onModuleDestroy();
  });
});
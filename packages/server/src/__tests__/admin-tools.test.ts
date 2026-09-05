import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbConnection } from '@zh/db';
import { hashToolRuleFiles } from '@zh/kernel';
import type { ToolRuleFile } from '@zh/kernel';
import { resolveMigrationsDir } from '../tenancy/tenancy.service';
import { SopContentAdminRepository } from '../sop/sop-content-admin.repository';
import { SopService } from '../sop/sop.service';
import { ToolRuleStore } from '../sop/tool-rule-store';
import { ToolRuleLoader } from '../sop/tool-rule-loader';
import { AdminService } from '../admin/admin.service';

const FILES_V1: ToolRuleFile[] = [{ filename: 'rules/v1.yml', content: 'v1-content' }];
const FILES_V2: ToolRuleFile[] = [{ filename: 'rules/v2.yml', content: 'v2-content' }];

// packages/server/src/__tests__ → 仓库根
const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
const FIXTURE_PACKS_DIR = join(REPO_ROOT, 'packages', 'kernel', 'test-fixtures', 'sop-content', 'tool-packs');

describe('AdminService 工具包管理（C4 写路径 + 读路径刷新）', () => {
  let dir: string;
  let dbPath: string;
  let adminRepo: SopContentAdminRepository;
  let toolStore: ToolRuleStore;
  let admin: AdminService;
  let db: ReturnType<DbConnection['getDb']>;

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'zh-admin-tools-'));
    dbPath = join(dir, 'test.db');
    process.env.ZH_SERVER_DB = dbPath;

    adminRepo = new SopContentAdminRepository();
    const sopService = new SopService(adminRepo);
    toolStore = new ToolRuleStore(new ToolRuleLoader(FIXTURE_PACKS_DIR), adminRepo);
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

  it('saveToolPackage 创建：version=1.<sha12>、sha256=H1、审计 create', async () => {
    const { created } = await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V1 });
    expect(created).toBe(true);

    const row = db.prepare('SELECT * FROM tool_package WHERE tool_id = ?').get('semgrep') as {
      sha256: string;
      version: string;
      status: string;
    };
    const sha = hashToolRuleFiles(FILES_V1);
    expect(row.sha256).toBe(sha);
    expect(row.version).toBe(`1.${sha.slice(0, 12)}`);
    expect(row.status).toBe('active');

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = 'semgrep' AND action = 'create'")
      .get();
    expect(audit).toBeDefined();
  });

  it('saveToolPackage 更新已存在：sha256 随文件变化、审计 update', async () => {
    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V1 });
    const { created } = await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V2 });
    expect(created).toBe(false);

    const row = db.prepare('SELECT * FROM tool_package WHERE tool_id = ?').get('semgrep') as {
      sha256: string;
    };
    expect(row.sha256).toBe(hashToolRuleFiles(FILES_V2));

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = 'semgrep' AND action = 'update'")
      .get();
    expect(audit).toBeDefined();
  });

  it('publishTool：历史快照 + active + 审计 publish；重复发布不产生重复历史（UNIQUE 守卫）', async () => {
    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V1 });
    await admin.publishTool('semgrep');
    await admin.publishTool('semgrep');

    const history = db
      .prepare('SELECT * FROM tool_package_version WHERE tool_id = ?')
      .all('semgrep') as Array<{ version: string }>;
    expect(history).toHaveLength(1);

    const row = db.prepare('SELECT * FROM tool_package WHERE tool_id = ?').get('semgrep') as {
      status: string;
    };
    expect(row.status).toBe('active');

    const audits = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = 'semgrep' AND action = 'publish'")
      .all();
    expect(audits).toHaveLength(2);
  });

  it('rollbackTool：从历史快照恢复 version/files、审计 rollback', async () => {
    const v1Version = `1.${hashToolRuleFiles(FILES_V1).slice(0, 12)}`;
    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V1 });
    await admin.publishTool('semgrep');
    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V2 });
    await admin.publishTool('semgrep');

    await admin.rollbackTool('semgrep', v1Version);

    const row = db.prepare('SELECT * FROM tool_package WHERE tool_id = ?').get('semgrep') as {
      version: string;
      status: string;
    };
    expect(row.version).toBe(v1Version);
    expect(row.status).toBe('active');

    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = 'semgrep' AND action = 'rollback'")
      .get();
    expect(audit).toBeDefined();
  });

  it('deleteTool：软删为 disabled、审计 delete', async () => {
    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V1 });
    await admin.deleteTool('semgrep');
    const row = db.prepare('SELECT * FROM tool_package WHERE tool_id = ?').get('semgrep') as {
      status: string;
    };
    expect(row.status).toBe('disabled');
    const audit = db
      .prepare("SELECT * FROM content_audit_log WHERE entity_id = 'semgrep' AND action = 'delete'")
      .get();
    expect(audit).toBeDefined();
  });

  it('写路径后 /version /download 立即刷新（reload 检查在 rollback 后、delete 前）', async () => {
    const v1Version = `1.${hashToolRuleFiles(FILES_V1).slice(0, 12)}`;
    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V1 });
    expect(toolStore.getRules('semgrep')).toEqual(FILES_V1);

    await admin.publishTool('semgrep');

    await admin.saveToolPackage({ toolId: 'semgrep', files: FILES_V2 });
    expect(toolStore.getRules('semgrep')).toEqual(FILES_V2);
    expect(toolStore.getVersion('semgrep').hash).toBe(hashToolRuleFiles(FILES_V2));

    await admin.publishTool('semgrep');
    await admin.rollbackTool('semgrep', v1Version);
    expect(toolStore.getRules('semgrep')).toEqual(FILES_V1);
    expect(toolStore.getVersion('semgrep').hash).toBe(hashToolRuleFiles(FILES_V1));

    await admin.deleteTool('semgrep');
    expect(toolStore.getRules('semgrep').length).toBeGreaterThan(0);
  });

  it('files 为空数组 → 400 BadRequestException', async () => {
    await expect(admin.saveToolPackage({ toolId: 'semgrep', files: [] })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('不存在的工具包 publish → 404 NotFoundException', async () => {
    await expect(admin.publishTool('nonexistent-tool')).rejects.toThrow(NotFoundException);
  });
});
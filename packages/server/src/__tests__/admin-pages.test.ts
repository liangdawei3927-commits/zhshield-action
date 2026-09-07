import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DbConnection } from '@zh/db';
import { hashToolRuleFiles } from '@zh/kernel';
import type { SopRule } from '@zh/kernel';
import { resolveMigrationsDir } from '../tenancy/tenancy.service';
import { AppModule } from '../app.module';
import { ADMIN_UI_PATHS } from '../admin/admin-pages-paths';
import { AdminService } from '../admin/admin.service';

const TOKEN = 'test-admin-token';

function makeRule(id: string): SopRule {
  return {
    id,
    name: `c5-${id}`,
    domain: 'security',
    action: 'scan',
    source: 'official',
    description: 'C5 SSR fixture rule',
    status: 'draft',
    executionMode: 'async',
    severity: 'high',
    applicableEngines: ['semgrep'],
    content: { rule: id },
    tags: ['c5-fixture'],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}

describe('C5 零依赖 SSR 管理后台页面（E2E）', () => {
  let dir: string;
  let dbPath: string;
  let app: INestApplication;
  let baseUrl: string;
  let admin: AdminService;
  let db: ReturnType<DbConnection['getDb']>;
  let cookie = '';
  let localToken = '';

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'zh-admin-pages-'));
    dbPath = join(dir, 'test.db');
    process.env.ZH_SERVER_DB = dbPath;
    process.env.ZH_ADMIN_TOKEN = TOKEN;

    const conn = new DbConnection({ dbPath, walMode: true });
    conn.connect();
    conn.migrate(resolveMigrationsDir());
    db = conn.getDb();

    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api/v1', {
      exclude: ['health', 'ready', 'live', 'metrics', ...ADMIN_UI_PATHS],
    });
    await app.listen(0);
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    admin = app.get(AdminService);
    // LocalOnlyGuard 在构造时读取/生成 ~/.zhshield/.api-token，resolve 端点需携带该令牌
    localToken = readFileSync(join(homedir(), '.zhshield', '.api-token'), 'utf-8').trim();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.ZH_SERVER_DB;
    delete process.env.ZH_ADMIN_TOKEN;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  }

  function postForm(path: string, fields: Record<string, string>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(fields),
      redirect: 'manual',
    });
  }

  function postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-token': localToken,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('未登录访问页面返回 401', async () => {
    const res = await get('/admin-ui/rules');
    expect(res.status).toBe(401);
  });

  it('登录成功设置 cookie，登录失败返回 401', async () => {
    const bad = await postForm('/admin-ui/login', { token: 'wrong' });
    expect(bad.status).toBe(401);

    const ok = await postForm('/admin-ui/login', { token: TOKEN });
    expect(ok.status).toBe(302);
    const sc = ok.headers.get('set-cookie') ?? '';
    expect(sc).toContain('zh_admin_token=');
    expect(sc).toContain('HttpOnly');
    const m = /^([^=]+=[^;]+)/.exec(sc);
    cookie = m ? m[1] : '';
    expect(cookie).toContain('zh_admin_token=');
  });

  it('规则列表与编辑页回显字段全部转义（XSS）', async () => {
    const rule = makeRule('security.scan.official.c5-xss');
    rule.name = '<script>alert(1)</script>';
    rule.description = 'desc "quoted" & <b>bold</b>';
    rule.tags = ['<img src=x onerror=alert(1)>'];
    rule.content = { rule: '<script>alert(1)</script>' };
    await admin.saveRule(rule);

    const list = await get('/admin-ui/rules');
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain('&lt;script&gt;');
    expect(listHtml).not.toContain('<script>alert(1)');

    const edit = await get(`/admin-ui/rules/${encodeURIComponent(rule.id)}`);
    expect(edit.status).toBe(200);
    const editHtml = await edit.text();
    expect(editHtml).toContain('&lt;script&gt;');
    expect(editHtml).toContain('&quot;');
    expect(editHtml).toContain('&amp;');
    expect(editHtml).toContain('&lt;b&gt;');
    expect(editHtml).not.toContain('<script>alert(1)');
  });

  it('编辑→发布→客户端同步→回滚 全链路', async () => {
    const rule = makeRule('security.scan.official.c5-e2e');
    await admin.saveRule(rule);

    const edit = await get(`/admin-ui/rules/${encodeURIComponent(rule.id)}`);
    expect(edit.status).toBe(200);
    const editHtml = await edit.text();
    expect(editHtml).toContain(`rule: ${rule.id}`);

    const save = await postForm(`/admin-ui/rules/${encodeURIComponent(rule.id)}/save`, {
      name: 'C5 端到端规则 v2',
      domain: 'security',
      action: 'scan',
      severity: 'high',
      tags: 'c5,e2e',
      description: 'updated via SSR form',
      content: 'rule: v2\n',
    });
    expect(save.status).toBe(303);
    expect(save.headers.get('location')).toContain(
      `/admin-ui/rules/${encodeURIComponent(rule.id)}`,
    );

    const publish = await postForm(`/admin-ui/rules/${encodeURIComponent(rule.id)}/publish`, {});
    expect(publish.status).toBe(303);

    const resolve = await postJson('/api/v1/resolve/rules', {
      orgId: 'org-c5',
      projectFeature: { framework: 'nestjs', language: 'typescript', features: [] },
      currentVersions: {},
    });
    expect(resolve.status).toBe(200);
    const body = (await resolve.json()) as {
      rules: Array<{
        ruleId: string;
        version: string;
        sha: string | null;
        languages: string[];
      }>;
    };
    const entry = body.rules.find((r) => r.ruleId === rule.id);
    expect(entry).toBeDefined();
    expect(entry!.version).toBe('1.0.1');
    const row = db
      .prepare('SELECT content_sha, version FROM rule_content WHERE rule_id = ?')
      .get(rule.id) as { content_sha: string; version: string };
    expect(entry!.sha).toBe(row.content_sha);

    const rollback = await postForm(`/admin-ui/rules/${encodeURIComponent(rule.id)}/rollback`, {
      version: '1.0.0',
    });
    expect(rollback.status).toBe(303);

    const scope = db
      .prepare('SELECT org_id, version, enabled FROM rule_scope WHERE rule_id = ?')
      .get(rule.id) as { org_id: string | null; version: string; enabled: number };
    expect(scope.org_id).toBeNull();
    expect(scope.version).toBe('1.0.0');
    expect(scope.enabled).toBe(1);
    const content = db
      .prepare('SELECT version, status FROM rule_content WHERE rule_id = ?')
      .get(rule.id) as { version: string; status: string };
    expect(content.version).toBe('1.0.0');
    expect(content.status).toBe('active');
  });

  it('工具详情页展示版本历史与回滚表单', async () => {
    const files = [{ filename: 'index.js', content: 'export default {};' }];
    const tool = await admin.saveToolPackage({
      toolId: 'c5-tool',
      files,
      description: 'fixture tool',
    });
    await admin.publishTool(tool.toolId);

    const detail = await get(`/admin-ui/tools/${encodeURIComponent(tool.toolId)}`);
    expect(detail.status).toBe(200);
    const html = await detail.text();
    const expectedVersion = `1.${hashToolRuleFiles(files).slice(0, 12)}`;
    expect(html).toContain(expectedVersion);
    expect(html).toContain(`/admin-ui/tools/${encodeURIComponent(tool.toolId)}/rollback`);
    expect(html).toContain('回滚');
  });

  it('C4 JSON API 仍可达（Bearer 鉴权）', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/rules`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});
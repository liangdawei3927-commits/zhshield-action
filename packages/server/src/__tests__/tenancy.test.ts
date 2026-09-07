import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbConnection, getProject, getProjectFeatures, saveRuleContent, saveToolPackage } from '@zh/db';
import { OrgsController, ResolveController } from '../tenancy/tenancy.controller';
import { resolveMigrationsDir, TenancyService } from '../tenancy/tenancy.service';
import { SERVER_TOOL_IDS } from '../sop/tool-rule.controller';

/**
 * M3 Stage B 验收测试（规格 §五 验收标准 2/3/4 的服务端半边）：
 * - 租户隔离：orgA 的规则快照对 orgB 不可见，平台默认（NULL）为双方兜底
 * - 画像裁剪：resolve/tools 按 isToolInScope 裁剪，画像缺失全量兼容
 * - 覆盖合并：组织行覆盖同 rule_id 的平台行
 */
describe('Tenancy (M3 Stage B)', () => {
  let dir: string;
  let tenancy: TenancyService;
  let orgs: OrgsController;
  let resolveCtrl: ResolveController;

  /** 独立连接向 tool_package 种子工具行（languages 缺省 → 列默认 '[]'） */
  function seedToolPackage(toolId: string, languages?: string[]): void {
    const conn = new DbConnection({ dbPath: join(dir, 'test.db'), walMode: true });
    conn.connect();
    conn.migrate(resolveMigrationsDir());
    saveToolPackage(conn.getDb(), {
      id: `tp-${toolId}`,
      toolId,
      version: '1.0.0',
      sha256: 'seed-sha',
      filesJson: '[]',
      languages,
      status: 'active',
    });
    conn.close();
  }

  /** 独立连接向 rule_content 种子规则行（languages 缺省 → 列默认 '[]'） */
  function seedRuleContent(ruleId: string, languages?: string[]): void {
    const conn = new DbConnection({ dbPath: join(dir, 'test.db'), walMode: true });
    conn.connect();
    conn.migrate(resolveMigrationsDir());
    saveRuleContent(conn.getDb(), {
      id: `rc-${ruleId}`,
      ruleId,
      domain: 'guard',
      action: 'scan',
      name: `seed-${ruleId}`,
      severity: 'high',
      content: '{}',
      contentSha: `sha-${ruleId}`,
      version: '1.0.0',
      languages,
    });
    conn.close();
  }

  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), 'zh-tenancy-'));
    process.env.ZH_SERVER_DB = join(dir, 'test.db');
    tenancy = new TenancyService();
    orgs = new OrgsController(tenancy);
    resolveCtrl = new ResolveController(tenancy);
  });

  afterEach(() => {
    tenancy.onModuleDestroy();
    delete process.env.ZH_SERVER_DB;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('组织创建：owner 自动入会且角色为 owner', () => {
    const { orgId } = orgs.createOrg({ name: 'acme', ownerId: 'u1' });
    expect(() => tenancy.assertMember(orgId, 'u1')).not.toThrow();
    expect(() => tenancy.assertMember(orgId, 'u2')).toThrow(/not a member/);
  });

  it('T0 画像注册：非成员被拒，成员可注册且快照可覆盖', () => {
    const { orgId } = orgs.createOrg({ name: 'acme', ownerId: 'u1' });
    expect(() =>
      orgs.putProjectFeatures(orgId, 'p1', { userId: 'intruder', features: ['nest'] }),
    ).toThrow(/not a member/);

    orgs.putProjectFeatures(orgId, 'p1', {
      userId: 'u1',
      name: 'demo',
      language: 'typescript',
      framework: 'nestjs',
      features: ['modular-monolith'],
    });
    // 二次注册走 upsert，不因 UNIQUE 冲突爆炸
    orgs.putProjectFeatures(orgId, 'p1', { userId: 'u1', language: 'typescript' });
  });

  it('T0 画像注销：注册后可注销，返回 ok 且快照行与 projects 行消失', () => {
    const { orgId } = orgs.createOrg({ name: 'acme', ownerId: 'u1' });
    orgs.putProjectFeatures(orgId, 'p1', {
      userId: 'u1',
      name: 'demo',
      language: 'typescript',
      framework: 'nestjs',
      features: ['modular-monolith'],
    });

    const res = orgs.deleteProjectFeatures(orgId, 'p1', { userId: 'u1' });
    expect(res).toEqual({ ok: true, projectId: 'p1', orgId });

    const conn = new DbConnection({ dbPath: join(dir, 'test.db') });
    const db = conn.connect();
    expect(getProjectFeatures(db, 'p1')).toBeUndefined();
    expect(getProject(db, 'p1')).toBeUndefined();
    conn.close();
  });

  it('T0 画像注销：非成员被拒', () => {
    const { orgId } = orgs.createOrg({ name: 'acme', ownerId: 'u1' });
    orgs.putProjectFeatures(orgId, 'p1', { userId: 'u1', language: 'typescript' });
    expect(() =>
      orgs.deleteProjectFeatures(orgId, 'p1', { userId: 'intruder' }),
    ).toThrow(/not a member/);
  });

  it('T0 画像注销：注销后 resolve 不再含该项目画像（features 为空）', () => {
    const { orgId } = orgs.createOrg({ name: 'acme', ownerId: 'u1' });
    orgs.putProjectFeatures(orgId, 'p1', {
      userId: 'u1',
      language: 'typescript',
      features: ['modular-monolith'],
    });
    orgs.deleteProjectFeatures(orgId, 'p1', { userId: 'u1' });

    const conn = new DbConnection({ dbPath: join(dir, 'test.db') });
    const db = conn.connect();
    expect(getProjectFeatures(db, 'p1')).toBeUndefined();
    conn.close();

    // resolve 侧不再携带已注销画像：无画像 → 缺省全量兼容
    expect(resolveCtrl.resolveTools({ orgId }).tools.map((t) => t.toolId)).toEqual([
      ...SERVER_TOOL_IDS,
    ]);
  });

  it('租户隔离：orgA 的规则对 orgB 不可见，平台默认双方可见', () => {
    const a = orgs.createOrg({ name: 'a', ownerId: 'u1' }).orgId;
    const b = orgs.createOrg({ name: 'b', ownerId: 'u2' }).orgId;

    // 平台默认（经 org 行写入仅演示；平台行走 orgId=null 路径）
    tenancy.publishRuleScope({ ruleId: 'platform-rule', orgId: null, version: '1.0.0' });
    // orgA 私有规则
    orgs.publishRule(a, { ruleId: 'org-a-only', version: '2.0.0' });

    const forA = resolveCtrl.resolveRules({ orgId: a });
    const forB = resolveCtrl.resolveRules({ orgId: b });
    const idsA = forA.rules.map((r) => r.ruleId);
    const idsB = forB.rules.map((r) => r.ruleId);

    expect(idsA).toContain('platform-rule');
    expect(idsA).toContain('org-a-only');
    expect(idsB).toContain('platform-rule');
    expect(idsB).not.toContain('org-a-only');
  });

  it('组织覆盖：同 rule_id 的组织行覆盖平台行（版本与来源）', () => {
    const a = orgs.createOrg({ name: 'a', ownerId: 'u1' }).orgId;
    tenancy.publishRuleScope({ ruleId: 'r1', orgId: null, version: '1.0.0' });
    tenancy.publishRuleScope({ ruleId: 'r1', orgId: a, version: '9.9.9' });

    const forA = resolveCtrl.resolveRules({ orgId: a });
    const r1 = forA.rules.find((r) => r.ruleId === 'r1')!;
    expect(r1.version).toBe('9.9.9');

    // currentVersions 差量：命中已最新版本的不进 changed
    expect(
      resolveCtrl.resolveRules({ orgId: a, currentVersions: { r1: '9.9.9' } }).changed,
    ).toEqual([]);
    expect(
      resolveCtrl.resolveRules({ orgId: a, currentVersions: { r1: '1.0.0' } }).changed,
    ).toEqual(['r1']);
  });

  it('content_sha 差量：客户端上报内容哈希一致 → 免重发；不一致 → 进 changed', () => {
    tenancy.publishRuleScope({
      ruleId: 'r-sha',
      orgId: null,
      version: '1.0.0',
      contentSha: 'aa66',
    });

    // 哈希一致：即使 version 字符串不同也视为内容未变（免重发）
    expect(
      resolveCtrl.resolveRules({ orgId: 'org-x', currentVersions: { 'r-sha': 'aa66' } }).changed,
    ).toEqual([]);
    // 哈希不一致：内容漂移 → 进 changed
    expect(
      resolveCtrl.resolveRules({ orgId: 'org-x', currentVersions: { 'r-sha': 'bb00' } }).changed,
    ).toEqual(['r-sha']);
    // content_sha 缺失的规则退化为 version 比较
    // （changed 为全量生效规则的差量：r-sha 本轮未上报 → 仍进 changed，故用成员断言）
    tenancy.publishRuleScope({ ruleId: 'r-nosha', orgId: null, version: '2.0.0' });
    expect(
      resolveCtrl.resolveRules({ orgId: 'org-x', currentVersions: { 'r-nosha': '2.0.0' } }).changed,
    ).not.toContain('r-nosha');
    expect(
      resolveCtrl.resolveRules({ orgId: 'org-x', currentVersions: { 'r-nosha': '9.9.9' } }).changed,
    ).toContain('r-nosha');
  });

  it('resolve/tools：画像裁剪（security 恒含，语言相关按 language），缺省全量', () => {
    const tsFeature = { language: 'typescript' };
    const pyFeature = { language: 'python' };

    const tsTools = resolveCtrl.resolveTools({ orgId: 'org-x', projectFeature: tsFeature }).tools.map(
      (t) => t.toolId,
    );
    const pyTools = resolveCtrl.resolveTools({ orgId: 'org-x', projectFeature: pyFeature }).tools.map(
      (t) => t.toolId,
    );
    const noFeature = resolveCtrl.resolveTools({ orgId: 'org-x' }).tools.map((t) => t.toolId);

    // security 域恒含
    for (const t of ['semgrep', 'trivy']) {
      expect(tsTools).toContain(t);
      expect(pyTools).toContain(t);
    }
    // 语言相关：TS 命中、Python 裁剪
    expect(tsTools).toContain('eslint');
    expect(pyTools).not.toContain('eslint');
    // 缺省全量兼容
    expect(noFeature).toEqual([...SERVER_TOOL_IDS]);
  });

  it('resolve/tools：透出 tool_package.languages（有值 + 缺省空数组）', () => {
    seedToolPackage('eslint', ['typescript', 'javascript']);
    seedToolPackage('semgrep'); // languages 缺省 → 列默认 '[]'

    const tools = resolveCtrl.resolveTools({ orgId: 'org-x' }).tools;
    expect(tools.find((t) => t.toolId === 'eslint')?.languages).toEqual([
      'typescript',
      'javascript',
    ]);
    expect(tools.find((t) => t.toolId === 'semgrep')?.languages).toEqual([]);
  });

  it('resolve/tools：DB 工具表为空 → 静态全集回退，每条 { toolId, languages: [] }', () => {
    const tools = resolveCtrl.resolveTools({ orgId: 'org-x' }).tools;
    expect(tools).toEqual(SERVER_TOOL_IDS.map((toolId) => ({ toolId, languages: [] })));
  });

  it('R3c 验收1：go 画像按 languages 元数据裁剪（eslint/tsc 剔除、semgrep 恒含）', () => {
    seedToolPackage('eslint', ['typescript', 'javascript']);
    seedToolPackage('tsc', ['typescript']);
    seedToolPackage('semgrep', ['*']);

    const goTools = resolveCtrl
      .resolveTools({ orgId: 'org-x', projectFeature: { language: 'go' } })
      .tools.map((t) => t.toolId);
    expect(goTools).not.toContain('eslint');
    expect(goTools).not.toContain('tsc');
    expect(goTools).toContain('semgrep');

    const tsTools = resolveCtrl
      .resolveTools({ orgId: 'org-x', projectFeature: { language: 'typescript' } })
      .tools.map((t) => t.toolId);
    expect(tsTools).toContain('eslint');
    expect(tsTools).toContain('tsc');
    expect(tsTools).toContain('semgrep');
  });

  it('R3c 验收2：languages 缺省/空数组 → 保守不裁（工具仍返回）', () => {
    seedToolPackage('eslint', []); // languages 空数组
    seedToolPackage('semgrep'); // languages 缺省 → 列默认 '[]'

    const goTools = resolveCtrl
      .resolveTools({ orgId: 'org-x', projectFeature: { language: 'go' } })
      .tools.map((t) => t.toolId);
    expect(goTools).toContain('eslint');
    expect(goTools).toContain('semgrep');
  });

  it('R3c 验收3：静态回退（DB 空表）→ 静态全集照旧全返回，languages 恒空', () => {
    const tools = resolveCtrl.resolveTools({ orgId: 'org-x' }).tools;
    expect(tools).toEqual(SERVER_TOOL_IDS.map((toolId) => ({ toolId, languages: [] })));
  });

  it('resolve/rules：规则条目 languages 关联 rule_content（无行 → 空数组）', () => {
    seedRuleContent('r-lang', ['typescript']);
    tenancy.publishRuleScope({ ruleId: 'r-lang', orgId: null, version: '1.0.0' });
    tenancy.publishRuleScope({ ruleId: 'r-nocontent', orgId: null, version: '1.0.0' });

    const rules = resolveCtrl.resolveRules({ orgId: 'org-x' }).rules;
    expect(rules.find((r) => r.ruleId === 'r-lang')?.languages).toEqual(['typescript']);
    expect(rules.find((r) => r.ruleId === 'r-nocontent')?.languages).toEqual([]);
  });

  it('resolve/health 与入参校验', () => {
    expect(resolveCtrl.health()).toEqual({ ok: true });
    expect(() => resolveCtrl.resolveTools({ orgId: '' })).toThrow(/orgId/);
    expect(() => resolveCtrl.resolveRules({ orgId: 'o', projectFeature: 'bad' })).toThrow(
      /projectFeature/,
    );
  });
});

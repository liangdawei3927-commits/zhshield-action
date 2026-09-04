import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrgsController, ResolveController } from '../tenancy/tenancy.controller';
import { TenancyService } from '../tenancy/tenancy.service';
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

  it('resolve/tools：画像裁剪（security 恒含，语言相关按 language），缺省全量', () => {
    const tsFeature = { language: 'typescript' };
    const pyFeature = { language: 'python' };

    const tsTools = resolveCtrl.resolveTools({ orgId: 'org-x', projectFeature: tsFeature }).tools;
    const pyTools = resolveCtrl.resolveTools({ orgId: 'org-x', projectFeature: pyFeature }).tools;
    const noFeature = resolveCtrl.resolveTools({ orgId: 'org-x' }).tools;

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

  it('resolve/health 与入参校验', () => {
    expect(resolveCtrl.health()).toEqual({ ok: true });
    expect(() => resolveCtrl.resolveTools({ orgId: '' })).toThrow(/orgId/);
    expect(() => resolveCtrl.resolveRules({ orgId: 'o', projectFeature: 'bad' })).toThrow(
      /projectFeature/,
    );
  });
});

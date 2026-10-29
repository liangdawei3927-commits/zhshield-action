import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SopLoader } from '../sop/_meta/sop-loader';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { makeRule } from './helpers/rule-factory';

/**
 * SOP 加载期字段校验回归集。
 *
 * 锁的是「拼错的枚举值必须变响」这个行为：原实现全靠类型断言，
 * `status: actived` 会被原样接受 —— 规则进 registry 却不匹配任何生命周期，
 * `getActive()` 永远取不到，等于**静默空跑**。因此每个反例都必须同时断言
 * 「被拒」与「不在执行集中」，只断言 loaded 数会漏掉后者的回归。
 */

let root: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sop-field-validation-'));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeRule(relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

/** 构造一条新格式（metadata/governance/execution/judgment 嵌套）规则 */
function ruleYaml(overrides: {
  id?: string;
  status?: string;
  source?: string;
  domain?: string;
  action?: string;
  priority?: string;
  tags?: string;
  extraMeta?: string;
} = {}): string {
  const lines = [
    'metadata:',
    `  id: ${overrides.id ?? 'guard.scan.official.sample'}`,
    '  name: sample-rule',
  ];
  if (overrides.status !== undefined) lines.push(`  status: ${overrides.status}`);
  if (overrides.source !== undefined) lines.push(`  source: ${overrides.source}`);
  if (overrides.extraMeta !== undefined) lines.push(`  ${overrides.extraMeta}`);
  if (overrides.tags !== undefined) lines.push(`  tags: ${overrides.tags}`);
  lines.push('governance:');
  lines.push(`  domain: ${overrides.domain ?? 'guard'}`);
  lines.push(`  action: ${overrides.action ?? 'scan'}`);
  if (overrides.priority !== undefined) {
    lines.push('judgment:');
    lines.push(`  priority: ${overrides.priority}`);
  }
  return `${lines.join('\n')}\n`;
}

async function load(): Promise<{ loader: SopLoader; registry: SopRegistry; loaded: number }> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: root });
  const loaded = await loader.loadFromFileSystem();
  return { loader, registry, loaded };
}

describe('SOP 字段校验 — 文件加载路径', () => {
  it('合法规则：正常加载、无问题、进入执行集', async () => {
    writeRule('guard/scan/ok.yml', ruleYaml({ status: 'active', source: 'official' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(1);
    expect(loader.getRuleIssues()).toHaveLength(0);
    expect(registry.count()).toBe(1);
    expect(registry.getActive()).toHaveLength(1);
  });

  it('status 拼错（actived）：规则被拒且不进执行集', async () => {
    writeRule('guard/scan/bad-status.yml', ruleYaml({ status: 'actived' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(0);
    expect(registry.count()).toBe(0);
    expect(registry.getActive()).toHaveLength(0);

    const issues = loader.getRuleIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'metadata.status', level: 'fatal', value: 'actived' });
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('bad-status.yml');
  });

  it('source 拼错（offical）：保留规则但留痕（该字段不参与执行筛选，不该因此丢检出）', async () => {
    writeRule('guard/scan/bad-source.yml', ruleYaml({ status: 'active', source: 'offical' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(1);
    expect(registry.getActive()).toHaveLength(1);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: 'metadata.source', level: 'warn' });
    // warn 同样要"变响"：只进 getRuleIssues 而控制台无痕，值班侧等于没有告警
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('bad-source.yml');
  });

  it('governance.domain 写非法值：规则被拒（否则会绕过治理域白名单）', async () => {
    writeRule('guard/scan/bad-domain.yml', ruleYaml({ status: 'active', domain: 'guards' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(0);
    expect(registry.count()).toBe(0);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: 'governance.domain', level: 'fatal' });
  });

  it('governance.domain 合法但与目录不一致：保留规则并留痕', async () => {
    writeRule('guard/scan/moved.yml', ruleYaml({ status: 'active', domain: 'security' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(1);
    expect(registry.getActive()[0]?.domain).toBe('security');
    expect(loader.getRuleIssues()).toHaveLength(1);
    expect(loader.getRuleIssues()[0]).toMatchObject({
      field: 'governance.domain',
      level: 'warn',
      value: 'security',
    });
  });

  it('tags 写成字符串：保留规则但归一化为空数组（否则下游 tags.filter 抛错）', async () => {
    writeRule('guard/scan/bad-tags.yml', ruleYaml({ status: 'active', tags: 'not-an-array' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(1);
    const rule = registry.getAll()[0];
    expect(rule?.tags).toEqual([]);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: 'metadata.tags', level: 'warn' });
  });

  it('judgment.priority 未知：保留规则、severity 降级并留痕', async () => {
    writeRule('guard/scan/odd-priority.yml', ruleYaml({ status: 'active', priority: 'urgent' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(1);
    expect(registry.getAll()[0]?.severity).toBe('medium');
    expect(loader.getRuleIssues()[0]).toMatchObject({
      field: 'judgment.priority',
      level: 'warn',
    });
  });

  it('JSON 根为数组：跳过并留痕（原实现会产出一条字段全空的壳规则）', async () => {
    writeRule('guard/scan/array.json', '[{"a":1}]');
    writeRule('guard/scan/ok2.yml', ruleYaml({ status: 'active', id: 'guard.scan.official.ok2' }));

    const { loader, registry, loaded } = await load();

    expect(loaded).toBe(1);
    expect(registry.count()).toBe(1);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: '<root>', level: 'warn' });
  });
});

describe('SOP 字段校验 — 云端同步路径（loadFromKnowledgeBase）', () => {
  it('status 非法的云端规则被拒收，且不进执行集', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry);

    await loader.loadFromKnowledgeBase([
      makeRule({ id: 'cloud.bad', status: 'actived' as never }),
      makeRule({ id: 'cloud.good' }),
    ]);

    expect(registry.get('cloud.bad')).toBeUndefined();
    expect(registry.get('cloud.good')).toBeDefined();
    expect(registry.getActive().map((r) => r.id)).toEqual(['cloud.good']);

    const issues = loader.getRuleIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: 'cloud-sync:cloud.bad',
      field: 'status',
      level: 'fatal',
    });
  });

  it('domain 非法的云端规则被拒收', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry);

    await loader.loadFromKnowledgeBase([makeRule({ id: 'cloud.bad-domain', domain: 'gurad' as never })]);

    expect(registry.count()).toBe(0);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: 'domain', level: 'fatal' });
  });

  it('tags 非数组的云端规则仍注册，但 tags 归一化为空数组', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry);

    await loader.loadFromKnowledgeBase([makeRule({ id: 'cloud.bad-tags', tags: 'oops' as never })]);

    expect(registry.get('cloud.bad-tags')?.tags).toEqual([]);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: 'tags', level: 'warn' });
  });

  it('id 为空的云端规则被拒收（身份缺失会导致去重/覆盖全失效）', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry);

    await loader.loadFromKnowledgeBase([makeRule({ id: '   ' })]);

    expect(registry.count()).toBe(0);
    expect(loader.getRuleIssues()[0]).toMatchObject({ field: 'id', level: 'fatal' });
  });
});

describe('SOP 枚举真源一致性', () => {
  it('内置 44 个规则文件应全部通过校验（新校验不得误伤存量规则）', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry);

    const loaded = await loader.loadFromFileSystem();

    expect(loaded).toBeGreaterThan(0);
    expect(loader.getRuleIssues().filter((i) => i.level === 'fatal')).toEqual([]);
  });
});

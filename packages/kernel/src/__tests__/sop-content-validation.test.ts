import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { validateRuleContent } from '../sop/_meta/sop-content-validation';
import { filterBuiltRules } from '../sop/_meta/sop-field-validation';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

/**
 * content 级校验回归集。
 *
 * 上一轮只补了元数据字段校验（status / domain / action），这一层补的是
 * 「元数据全对、但 content 里的检查指令跑不起来」—— 元数据校验全过、规则在面板上
 * 显示 active，实际一条检查都不做。改动前云端 45 条 official 规则 0 误伤。
 */

const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

/** 只有元数据键、没有任何执行段 —— 云端 6 条 draft 规则的真实形态 */
const META_ONLY_CONTENT = {
  name: 'Backdoor Detection',
  description: '检测后门特征',
  severity: 'critical',
  executionMode: 'async',
  status: 'active',
  source: 'official',
  tags: ['security'],
  applicableEngines: ['semgrep'],
};

describe('validateRuleContent — 无执行段', () => {
  it('active 规则无任何可执行指令段 ⇒ fatal（每次体检固定降级却零产出）', () => {
    const rule = makeRule({ id: 'a', status: 'active', content: META_ONLY_CONTENT });

    const issues = validateRuleContent(rule, 'cloud-sync:a');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'content', level: 'fatal' });
    expect(issues[0]?.reason).toContain('degraded');
  });

  it('draft 规则同样无执行段 ⇒ 只 warn（内容未完成属正常阶段，不得拒收）', () => {
    // 实测：云端 7 条无执行段的规则全部是 draft。若判 fatal，
    // 会把作者正在写的规则连同标签一起清掉。
    const rule = makeRule({ id: 'b', status: 'draft', content: META_ONLY_CONTENT });

    const issues = validateRuleContent(rule, 'cloud-sync:b');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warn');
  });

  it('content 为空对象 ⇒ 不产生问题（"还没写"不等于"写错了"）', () => {
    const rule = makeRule({ id: 'c', status: 'active', content: {} });
    expect(validateRuleContent(rule, 'cloud-sync:c')).toEqual([]);
  });
});

describe('validateRuleContent — tool 写错位置', () => {
  /**
   * 云端 `security.scan.internal.unused-file` 的真实形态：
   * tool 写在 content 顶层，而解释器只认 check.tool ⇒ 永不派发。
   * 这类错误必须点名「应该怎么写」，否则作者改不对。
   */
  const TOP_LEVEL_TOOL_CONTENT = { ...META_ONLY_CONTENT, tool: 'ts-prune', ignore: ['**/*.d.ts'] };

  it('active 且 tool 写在顶层 ⇒ fatal 且 reason 指明 check.tool 写法', () => {
    const rule = makeRule({ id: 'd', status: 'active', content: TOP_LEVEL_TOOL_CONTENT });

    const issues = validateRuleContent(rule, 'cloud-sync:d');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'content.tool', level: 'fatal' });
    expect(issues[0]?.reason).toContain('check.tool');
    expect(issues[0]?.reason).toContain('ts-prune');
  });

  it('draft 且 tool 写在顶层 ⇒ warn（留痕但不拒收）', () => {
    const rule = makeRule({ id: 'e', status: 'draft', content: TOP_LEVEL_TOOL_CONTENT });
    expect(validateRuleContent(rule, 'cloud-sync:e')[0]?.level).toBe('warn');
  });
});

describe('validateRuleContent — tool-dispatch', () => {
  it('合法工具名（eslint）⇒ 无问题', () => {
    const rule = makeRule({
      id: 'f',
      content: { check: { tool: 'eslint', rules: [{ rule: 'no-console' }] } },
    });
    expect(validateRuleContent(rule, 'cloud-sync:f')).toEqual([]);
  });

  it('tool 取值为空 ⇒ fatal（派发必然失败）', () => {
    const rule = makeRule({ id: 'g', content: { check: { tool: '' } } });

    const issues = validateRuleContent(rule, 'cloud-sync:g');

    expect(issues[0]).toMatchObject({ field: 'content.check.tool', level: 'fatal' });
  });

  it('tool 不在 TOOL_IDS ⇒ warn（可能是外部适配器，判 fatal 会误杀）', () => {
    // presets 里 sentinel / evolve 域有 5 条此类存量，判 fatal 会一次性拒掉它们
    const rule = makeRule({ id: 'h', content: { check: { tool: 'scoring-engine' } } });

    const issues = validateRuleContent(rule, 'cloud-sync:h');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warn');
    expect(issues[0]?.reason).toContain('scoring-engine');
  });
});

describe('validateRuleContent — forbidden-regex 正则安全校验', () => {
  it('安全正则 ⇒ 无问题', () => {
    const rule = makeRule({
      id: 'i',
      content: { forbiddenRegex: [{ regex: 'as\\s+any', message: '禁止 as any' }] },
    });
    expect(validateRuleContent(rule, 'cloud-sync:i')).toEqual([]);
  });

  it('灾难性回溯正则 ⇒ warn 并指名 items 下标（运行期会被静默跳过）', () => {
    const rule = makeRule({
      id: 'j',
      content: {
        forbiddenRegex: [
          { regex: 'safe-pattern' },
          { regex: '(a+)+', message: '危险' },
        ],
      },
    });

    const issues = validateRuleContent(rule, 'cloud-sync:j');

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('content.forbiddenRegex.items[1].regex');
    expect(issues[0]?.level).toBe('warn');
    expect(issues[0]?.reason).toContain('静默跳过');
  });
});

describe('validateRuleContent — threshold 字段级', () => {
  it('threshold 写成字符串 ⇒ fatal 并给出正确写法（解释器只认 number）', () => {
    const rule = makeRule({
      id: 'k',
      status: 'active',
      content: { threshold: '80', unit: 'percent' },
    });

    const issues = validateRuleContent(rule, 'cloud-sync:k');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'content.threshold', level: 'fatal' });
    expect(issues[0]?.reason).toContain('threshold: 80');
  });

  it('thresholds 值不可转数字 ⇒ fatal（Number 得 NaN 后比较恒 false）', () => {
    const rule = makeRule({
      id: 'l',
      status: 'active',
      content: { thresholds: { nestingDepth: 'four' } },
    });

    const issues = validateRuleContent(rule, 'cloud-sync:l');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'content.thresholds.nestingDepth', level: 'fatal' });
    expect(issues[0]?.reason).toContain('NaN');
  });

  it('thresholds 为空对象 ⇒ warn（执行时必然降级）', () => {
    const rule = makeRule({ id: 'm', status: 'active', content: { thresholds: {} } });

    const issues = validateRuleContent(rule, 'cloud-sync:m');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'content.thresholds', level: 'warn' });
  });

  it('合法数值阈值 ⇒ 无问题（反向用例：不得把正常规则判坏）', () => {
    const rule = makeRule({
      id: 'n',
      status: 'active',
      content: { thresholds: { cyclomaticComplexity: 10, fileLength: 300 } },
    });

    expect(validateRuleContent(rule, 'cloud-sync:n')).toEqual([]);
  });
});

describe('validateRuleContent — forbidden-regex 结构', () => {
  it('全部条目缺字符串 regex ⇒ warn（解释器 filter 后为空，恒 0 命中）', () => {
    const rule = makeRule({
      id: 'o',
      content: { forbiddenRegex: [{ pattern: 'as any' }, { regex: 123 }] },
    });

    const issues = validateRuleContent(rule, 'cloud-sync:o');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ field: 'content.forbiddenRegex', level: 'warn' });
    expect(issues[0]?.reason).toContain('2 条');
  });
});

describe('filterBuiltRules — 分级拒收', () => {
  it('只拒 active 幽灵，draft 幽灵保留并留痕', () => {
    const rules: SopRule[] = [
      makeRule({ id: 'guard.scan.official.good', content: { patterns: ['x'] } }),
      makeRule({ id: 'guard.scan.official.ghost', status: 'active', content: META_ONLY_CONTENT }),
      makeRule({ id: 'guard.scan.official.wip', status: 'draft', content: META_ONLY_CONTENT }),
    ];

    const { accepted, issues } = filterBuiltRules(rules, 'cloud-sync');

    expect(accepted.map((r) => r.id)).toEqual([
      'guard.scan.official.good',
      'guard.scan.official.wip',
    ]);
    expect(issues.filter((i) => i.level === 'fatal')).toHaveLength(1);
    expect(issues.filter((i) => i.level === 'warn')).toHaveLength(1);
  });
});

describe('filterBuiltRules — 内置 presets 零误伤', () => {
  it('43 条内置规则全部通过 content 校验（不得因新增校验拒掉真实规则）', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
    await loader.loadFromFileSystem();
    const all = registry.getAll();
    expect(all.length).toBeGreaterThan(0);

    const { accepted, issues } = filterBuiltRules(all, 'presets');
    const fatal = issues.filter((i) => i.level === 'fatal');

    // 内置规则是产品能力的基线：任何一条被拒都说明校验判据过严
    expect(fatal).toEqual([]);
    expect(accepted).toHaveLength(all.length);
  });
});

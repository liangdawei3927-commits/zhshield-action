import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { TOOL_IDS } from '@zh/shared';
import { ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';
import { SOP_SERVED_DOMAINS, auditRuleWiring, classifyRuleWiring } from '../sop/_meta/rule-wiring';

/**
 * 规则接线审计（《07》§四 O6）：rules.db 里「永远求值不到」的规则必须能被识别出来。
 *
 * 背景：同一份重复代码/依赖漏洞在体检、重构、垃圾三个域各报一次（一题多答），
 * 而云端 rules.db 里还写着一套 refactor / sentinel / evolve 规则 —— 引擎根本没有
 * 这些域的 SOP 求值入口，这些规则从来不会产出结论，却计入「N 条规则参与判定」。
 * 本组用例锁死三条判据：
 *   ① 域不服务的规则 ⇒ orphan(domain-not-served)
 *   ② content 解释不出可执行指令 ⇒ orphan(unresolved-content)
 *   ③ 声明的工具不在 TOOL_IDS（伪 tool）⇒ orphan(tool-not-registered)
 */

/** 内置 presets 目录（产品实际加载的那份，见 sop-presets-interpretable.test.ts） */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

function makeRule(
  id: string,
  domain: SopRule['domain'],
  content: Record<string, unknown>,
): SopRule {
  return {
    id,
    name: id,
    domain,
    action: 'scan',
    source: 'internal',
    description: id,
    status: 'active',
    executionMode: 'sync',
    severity: 'high',
    applicableEngines: ['inspect'],
    content,
    tags: [],
    falsePositiveCount: 0,
    truePositiveCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('SOP 规则接线审计 — orphan 判定', () => {
  const interpreter = new ContentInterpreter();

  it('域不服务 ⇒ domain-not-served（refactor/sentinel/evolve 没有 SOP 求值入口）', () => {
    // content 本身完全合法（forbidden 是可执行指令），唯独域没人跑 ——
    // 若按 content 判定会误判为 wired，这正是 O6 要抓的「规则两层定义」。
    const rule = makeRule('refactor.scan.official.long-function', 'refactor', {
      forbidden: ['TODO'],
    });

    const result = classifyRuleWiring(rule, interpreter.interpret(rule));
    expect(result?.reason).toBe('domain-not-served');
    expect(result?.domain).toBe('refactor');
  });

  it('content 不可解释 ⇒ unresolved-content（连指令都没有，永远零产出）', () => {
    const rule = makeRule('inspect.scan.official.empty-shell', 'inspect', {
      rules: ['no-var'],
    });

    const result = classifyRuleWiring(rule, interpreter.interpret(rule));
    expect(result?.reason).toBe('unresolved-content');
  });

  it('tool-dispatch 工具为空 ⇒ tool-missing', () => {
    const rule = makeRule('security.scan.official.blank-tool', 'security', {
      check: { tool: '   ' },
    });

    const result = classifyRuleWiring(rule, interpreter.interpret(rule));
    expect(result?.reason).toBe('tool-missing');
  });

  it('伪 tool（不在 TOOL_IDS）⇒ tool-not-registered，并带上工具名', () => {
    const rule = makeRule('security.scan.external.malware', 'security', {
      check: { tool: 'custom-malware-scanner' },
    });

    const result = classifyRuleWiring(rule, interpreter.interpret(rule));
    expect(result?.reason).toBe('tool-not-registered');
    expect(result?.tool).toBe('custom-malware-scanner');
  });

  it('真实工具 + 受服务域 ⇒ 接线正常（返回 null）', () => {
    const rule = makeRule('security.scan.semgrep.sql-injection', 'security', {
      check: { tool: 'semgrep' },
    });

    expect(classifyRuleWiring(rule, interpreter.interpret(rule))).toBeNull();
  });

  it('审计汇总只把 orphan 计入 orphans，wired = total - orphans', () => {
    const rules = [
      makeRule('security.scan.semgrep.xss', 'security', { check: { tool: 'semgrep' } }),
      makeRule('guard.block.internal.sensitive-info', 'guard', { check: { tool: 'gitleaks' } }),
      makeRule('inspect.scan.internal.type-consistency', 'inspect', {
        forbiddenRegex: [{ regex: 'as any' }],
      }),
      makeRule('evolve.score.official.dimension-weight', 'evolve', { check: { tool: 'semgrep' } }),
    ];

    const report = auditRuleWiring(rules, interpreter);
    expect(report.total).toBe(4);
    expect(report.wired).toBe(3);
    expect(report.orphans.map((o) => o.ruleId)).toEqual(['evolve.score.official.dimension-weight']);
  });

  it('服务域清单与引擎过滤口径一致（guard + 全量巡检三域）', () => {
    expect([...SOP_SERVED_DOMAINS]).toEqual(['guard', 'inspect', 'security', 'garbage']);
  });
});

describe('SOP 规则接线审计 — 内置 presets 实测', () => {
  it('内置 presets 的 orphan 原因可复核，且不会误伤受服务域的真实规则', async () => {
    const registry = new SopRegistry();
    const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
    await loader.loadFromFileSystem();

    const report = auditRuleWiring(registry.getAll());
    expect(report.total).toBe(registry.count());

    for (const orphan of report.orphans) {
      expect(orphan.detail.length).toBeGreaterThan(0);
      const rule = registry.get(orphan.ruleId);
      expect(rule).toBeDefined();
      // 判据复核：原因必须与规则本身一致，不能是「随手标 orphan」
      if (orphan.reason === 'domain-not-served') {
        expect(SOP_SERVED_DOMAINS as readonly string[]).not.toContain(rule!.domain);
      }
      if (orphan.reason === 'tool-not-registered') {
        expect(TOOL_IDS as readonly string[]).not.toContain(orphan.tool);
      }
      if (orphan.reason === 'unresolved-content') {
        expect(new ContentInterpreter().interpret(rule!).type).toBe('unresolved');
      }
    }

    // 内置 presets 里确实存在「只有规则、没有 SOP 求值入口」的死规则（evolve / sentinel），
    // 审计必须能抓到它们 —— 否则 O6 的对齐就是空转。
    expect(report.orphans.some((o) => o.domain === 'evolve' || o.domain === 'sentinel')).toBe(true);

    // 受服务域内，指令可解释且工具真实的规则一律必须 wired：
    // 把「环境没装工具」误判成接线缺失，会让 C4 的 skipped 语义失效。
    const servedWired = registry.getAll().filter((rule) => {
      if (!(SOP_SERVED_DOMAINS as readonly string[]).includes(rule.domain)) return false;
      const instr = new ContentInterpreter().interpret(rule);
      if (instr.type === 'unresolved') return false;
      return instr.type !== 'tool-dispatch' || (TOOL_IDS as readonly string[]).includes(instr.tool);
    });
    const orphanIds = new Set(report.orphans.map((o) => o.ruleId));
    expect(servedWired.map((r) => r.id).filter((id) => orphanIds.has(id))).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { ContentInterpreter } from '../sop/_meta/content-interpreter';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';
import {
  DOMAIN_EXECUTION_PATHS,
  auditCapabilityClosure,
  classifyCapability,
  isClosureAcceptable,
  isSopServedDomain,
} from '../sop/_meta/capability-closure';

/**
 * 检测能力闭环审计的验收用例。
 *
 * 锁定的是一条**架构不变量**：
 *   「一条 active 且内容可解释的规则，若其所属域的执行路径会经过 SOP 规则引擎，
 *     则它必然会被求值；否则它就是一条永远不会被执行的规则。」
 *
 * 这条不变量一旦破掉，用户看到的现象是「点按钮没反应 / 报告里 0 条但没有任何异常提示」——
 * 也就是本项目最忌讳的「把没检测显示成很干净」。
 *
 * 判据形式采用「声明 vs 实际」比对，而非黑名单：
 * 新增规则自动纳入，无需维护规则 id 列表。
 */

const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

async function loadAllPresetRules(): Promise<SopRule[]> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return registry.getAll();
}

function makeRule(overrides: Partial<SopRule> & Pick<SopRule, 'id' | 'domain'>): SopRule {
  return {
    name: overrides.id,
    action: 'scan',
    source: 'internal',
    description: '',
    status: 'active',
    executionMode: 'sync',
    severity: 'medium',
    content: {},
    ...overrides,
  } as SopRule;
}

describe('能力闭环审计 — 判定逻辑', () => {
  const interpreter = new ContentInterpreter();

  it('非 active 规则标 rule-not-active，且不算断链', () => {
    const rule = makeRule({
      id: 'inspect.scan.test.draft',
      domain: 'inspect',
      status: 'draft',
      content: { forbidden: ['TODO'] },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('rule-not-active');
    expect(item.active).toBe(false);
  });

  it('域不在 SOP 服务域 → domain-not-served', () => {
    const rule = makeRule({
      id: 'evolve.score.test',
      domain: 'evolve',
      content: { forbidden: ['TODO'] },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('domain-not-served');
  });

  it('content 不可解释 → unresolved-content', () => {
    const rule = makeRule({
      id: 'inspect.scan.test.unresolved',
      domain: 'inspect',
      content: { totallyUnknownField: 1 },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('unresolved-content');
  });

  it('声明的工具不在 TOOL_IDS → tool-not-registered', () => {
    const rule = makeRule({
      id: 'inspect.scan.test.faketool',
      domain: 'inspect',
      content: { check: { tool: 'no-such-tool' } },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('tool-not-registered');
  });

  it('域走域专属执行器 → path-bypasses-sop-engine（核心断裂判据）', () => {
    // 显式指定路径，覆盖「域在 SOP 服务域内、但当前装配不走 SOP 引擎」这一分支。
    // 这正是 2026-11-02 security 域的断裂形态（当时路径是 domain-executor）。
    const rule = makeRule({
      id: 'security.scan.test.bypass',
      domain: 'security',
      content: { check: { tool: 'semgrep' } },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule), 'domain-executor');
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('path-bypasses-sop-engine');
    expect(item.detail).toContain('domain-executor');
  });

  it('域不在 SOP 服务域 → domain-not-served（优先级高于路径判定）', () => {
    const rule = makeRule({
      id: 'deps.scan.test.bypass',
      domain: 'deps',
      content: { check: { tool: 'semgrep' } },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(DOMAIN_EXECUTION_PATHS.deps).toBe('domain-executor');
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('domain-not-served');
  });

  it('走 SOP 引擎路径的健康规则 → effective', () => {
    const rule = makeRule({
      id: 'inspect.scan.test.ok',
      domain: 'inspect',
      content: { forbidden: ['TODO'] },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(item.effective).toBe(true);
    expect(item.breakReason).toBeUndefined();
  });

  it('门禁域是纯判定域：规则仍会被求值（只是不启工具）→ 不算断裂', () => {
    const rule = makeRule({
      id: 'guard.block.test',
      domain: 'guard',
      content: { check: { tool: 'eslint' } },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(DOMAIN_EXECUTION_PATHS.guard).toBe('conclusion-only');
    // 门禁由 SopRuleEngine.runGuard 求值，规则确实会被执行 → 不是断链
    expect(item.effective).toBe(true);
    expect(item.breakReason).toBeUndefined();
  });

  it('运行时域（sentinel / backup）无 SOP 求值入口 → domain-not-served', () => {
    const rule = makeRule({
      id: 'sentinel.alert.test',
      domain: 'sentinel',
      content: { forbidden: ['TODO'] },
    });
    const item = classifyCapability(rule, interpreter.interpret(rule));
    expect(item.effective).toBe(false);
    expect(item.breakReason).toBe('domain-not-served');
  });
});

describe('能力闭环审计 — 域路径表', () => {
  it('每个域都有明确路径（无 undefined）', () => {
    for (const [domain, path] of Object.entries(DOMAIN_EXECUTION_PATHS)) {
      expect(path, `域 ${domain} 缺执行路径`).toBeTruthy();
    }
  });

  it('SOP 服务域含 guard + INSPECT_SCOPE_DOMAINS（与 rule-wiring 同源）', () => {
    expect(isSopServedDomain('inspect')).toBe(true);
    expect(isSopServedDomain('security')).toBe(true);
    expect(isSopServedDomain('garbage')).toBe(true);
    expect(isSopServedDomain('guard')).toBe(true);
    expect(isSopServedDomain('sentinel')).toBe(false);
    expect(isSopServedDomain('evolve')).toBe(false);
  });
});

describe('能力闭环审计 — 内置规则库实况', () => {
  it('内置规则全部加载成功', async () => {
    const rules = await loadAllPresetRules();
    expect(rules.length).toBeGreaterThan(0);
  });

  it('auditCapabilityClosure 的计数自洽（effective + broken = active）', async () => {
    const rules = await loadAllPresetRules();
    const report = auditCapabilityClosure(rules);

    expect(report.effectiveTotal + report.brokenTotal).toBe(report.activeTotal);
    expect(report.declaredTotal).toBe(rules.length);
    expect(report.activeTotal).toBe(rules.filter((r) => r.status === 'active').length);
  });

  it('每条断链明细都带可读原因（不得是空串）', async () => {
    const rules = await loadAllPresetRules();
    const report = auditCapabilityClosure(rules);

    for (const item of report.breaks) {
      expect(item.detail, `断链 ${item.ruleId} 缺少说明`).toBeTruthy();
      expect(item.breakReason, `断链 ${item.ruleId} 缺少原因`).toBeTruthy();
    }
  });

  it('security 域的 semgrep 规则已接回 SOP 路径（2026-11-02 修复后回归）', async () => {
    const rules = await loadAllPresetRules();
    const report = auditCapabilityClosure(rules);

    const securitySemgrep = report.domains
      .flatMap((d) => d.items)
      .filter((i) => i.domain === 'security' && i.tool === 'semgrep');

    expect(securitySemgrep.length, 'security 域应有 semgrep 规则').toBeGreaterThan(0);
    for (const item of securitySemgrep) {
      if (!item.active) {
        // 非 active 是正常生命周期状态，不是断裂
        expect(item.breakReason).toBe('rule-not-active');
        continue;
      }
      expect(item.effective, `规则 ${item.ruleId} 应生效`).toBe(true);
      expect(item.breakReason).toBeUndefined();
    }
  });

  it('内置规则库当前无 active 断链（CI 门禁基线）', async () => {
    const rules = await loadAllPresetRules();
    const report = auditCapabilityClosure(rules);

    expect(
      report.breaks.map((b) => `${b.ruleId}:${b.breakReason}`),
      '仍有 active 规则永远不会执行 —— 修完 security 域后应清零',
    ).toEqual([]);
    expect(isClosureAcceptable(report)).toBe(true);
  });

  it('非 active 的规则不会被算成断链（draft/trial 是正常生命周期）', async () => {
    const rules = await loadAllPresetRules();
    const report = auditCapabilityClosure(rules);

    const notActive = report.domains
      .flatMap((d) => d.items)
      .filter((i) => !i.active && i.breakReason !== 'rule-not-active');
    expect(notActive, '非 active 规则的原因必须是 rule-not-active').toEqual([]);
  });
});

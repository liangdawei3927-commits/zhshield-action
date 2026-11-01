import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { resolveOwnerId, DOMAIN_IDS, type DomainId } from '@zh/shared';

import { ContentInterpreter } from '../runner';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * 《07》§三/§四 域边界声明层验收（A3 / A4 / A5）。
 *
 * 为什么在 kernel 里测：内置规则资产（sop-templates）归 kernel 所有，域边界是
 * 「这条规则由谁产出、issue 记到谁头上」的声明问题，和 shared 的归属注册表同源。
 *
 * 判据形式：把「规则所在域」与「归属注册表裁定」逐条对齐 —— 不一致就说明
 * 引擎在自己域里跑了一类本该归别人的检测（一题多答的根因）。这比分别写
 * "inspect 不能有 duplication" 更耐用：新增规则自动纳入，无需维护黑名单。
 *
 * 边界：本用例只验「声明层」。真实埋雷夹具跑通（issue 级交叉比对）仍需端到端，
 * 对应《07》A3/A4/A5 的运行时部分，未在此处冒充已验。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

async function loadAllPresetRules(): Promise<SopRule[]> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return registry.getAll();
}

describe('《07》域边界 — 内置规则归属一致性', () => {
  it('每条内置规则的 owner 裁定等于它所在的域（否则就是跨域抢答）', async () => {
    const rules = await loadAllPresetRules();
    expect(rules.length).toBeGreaterThan(0);

    // guard 是判定域：其规则条目表示「准入判定入口」，读供应商域结论判 pass/fail，
    // 自身不产出 issue（见 runner/dispatch-guard-conclusion.ts），因此 ruleId 前缀
    // 不参与 issue 归属。例如 guard.block.external.sensitive-info 的裁定是 security，
    // 那正是 O3 要的「密钥唯一归安全」。
    const mismatched = rules
      .filter((rule) => rule.domain !== 'guard')
      .filter((rule) => DOMAIN_IDS.includes(rule.domain as DomainId))
      .map((rule) => ({ rule, owner: resolveOwnerId(rule.id) }))
      .filter(({ rule, owner }) => owner !== rule.domain)
      .map(({ rule, owner }) => `${rule.id}（所在域 ${rule.domain}，裁定 ${owner ?? 'null'}）`);

    expect(mismatched, '规则需么改归属、要么改域，不得两边不一致').toEqual([]);
  });

  it('A3 重复代码唯一归重构：inspect 域不得产出重复类规则', async () => {
    const rules = await loadAllPresetRules();
    const duplicationTokens = ['duplication', 'duplicated-code', 'jscpd'];

    const offenders = rules
      .filter((rule) => rule.domain === 'inspect')
      .filter((rule) => duplicationTokens.some((token) => rule.id.includes(token)))
      .map((rule) => rule.id);

    expect(offenders, '体检只读重复率指标，重复明细必须由重构域产出（O1）').toEqual([]);
  });

  it('A4 安全与依赖互不越界：security 不碰依赖 CVE，deps 不碰代码漏洞', async () => {
    const rules = await loadAllPresetRules();
    const interpreter = new ContentInterpreter();
    const depCveTools = ['trivy', 'grype'];

    const securityOffenders = rules
      .filter((rule) => rule.domain === 'security')
      .filter((rule) => {
        if (/cve|trivy|grype|osv/.test(rule.id)) return true;
        const instr = interpreter.interpret(rule);
        return instr.type === 'tool-dispatch' && depCveTools.includes(instr.tool);
      })
      .map((rule) => rule.id);

    const depsOffenders = rules
      .filter((rule) => rule.domain === 'deps')
      .filter((rule) => /semgrep|injection|xss|ssrf/.test(rule.id))
      .map((rule) => rule.id);

    expect(securityOffenders, '依赖包 CVE 唯一归依赖管家（O2/O10）').toEqual([]);
    expect(depsOffenders, '代码漏洞唯一归安全中心（O9）').toEqual([]);
  });

  it('A5 垃圾清理与依赖管家边界：garbage 不报重复、deps 不报未用依赖', async () => {
    const rules = await loadAllPresetRules();

    const garbageOffenders = rules
      .filter((rule) => rule.domain === 'garbage')
      .filter((rule) => /duplication|duplicated-code/.test(rule.id))
      .map((rule) => rule.id);

    const depsOffenders = rules
      .filter((rule) => rule.domain === 'deps')
      .filter((rule) => /unused-dependency|dead-code/.test(rule.id))
      .map((rule) => rule.id);

    expect(garbageOffenders, '重复代码唯一归重构（O1）').toEqual([]);
    expect(depsOffenders, '未使用依赖唯一归垃圾清理（O7）').toEqual([]);
  });
});

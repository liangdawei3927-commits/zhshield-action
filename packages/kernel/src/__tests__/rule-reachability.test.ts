import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import { checkRuleReachability } from '../runner/rule-reachability';
import type { SopRule } from '../sop/_meta/sop-types';
import { makeRule } from './helpers/rule-factory';

/**
 * R7 §3.5：静态可达性门禁的双向自检。
 *
 * 「当前规则集通过」不算验过 —— 必须证明它**真的会红**（夹具埋一条不可调度的规则），
 * 且对归属让位的规则**不误报**（否则所有人会去关掉这个门禁）。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

async function loadRealRules(): Promise<SopRule[]> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return registry.getAll();
}

describe('checkRuleReachability — 静态可达性（R7）', () => {
  it('内置规则集：检查到 tool-dispatch 规则，且无 active 规则声明未登记工具', async () => {
    const result = checkRuleReachability(await loadRealRules());

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    // 有效性自检：确实检查到了规则，不是空集静默通过
    expect(result.checked).toBeGreaterThan(0);
  });

  it('active 规则声明未登记工具 → 违反（门禁必须会红）', () => {
    const result = checkRuleReachability([
      makeRule({
        id: 'inspect.scan.internal.bogus-tool',
        domain: 'inspect',
        status: 'active',
        content: { check: { tool: 'not-in-capability-table' } },
      }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      ruleId: 'inspect.scan.internal.bogus-tool',
      tool: 'not-in-capability-table',
      kind: 'unregistered-tool',
    });
  });

  it('归属其它域的规则 → 让位，不误报', () => {
    const result = checkRuleReachability([
      makeRule({
        id: 'inspect.scan.external.dependency-audit',
        domain: 'inspect',
        status: 'active',
        content: { check: { tool: 'npm-audit' } },
      }),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.delegated).toBe(1);
  });

  it('scanners 形态同样检查：多扫描器中任一未登记即违反', () => {
    const result = checkRuleReachability([
      makeRule({
        id: 'security.scan.internal.multi',
        domain: 'security',
        status: 'active',
        content: { check: { scanners: ['semgrep', 'ghost-scanner'] } },
      }),
    ]);

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.tool)).toEqual(['ghost-scanner']);
  });

  it('draft 规则声明未登记工具 → 只记 warning，不判失败', () => {
    const result = checkRuleReachability([
      makeRule({
        id: 'security.scan.malware.reverse-shell',
        domain: 'security',
        status: 'draft',
        content: { check: { tool: 'custom-malware-scanner' } },
      }),
    ]);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].reason).toContain('投产前');
  });

  it('空规则集 → INVALID，而不是通过', () => {
    const result = checkRuleReachability([]);

    expect(result.ok).toBe(false);
    expect(result.invalidReason).toContain('INVALID');
  });
});

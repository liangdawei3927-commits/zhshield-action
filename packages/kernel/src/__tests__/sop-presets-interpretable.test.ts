import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { ContentInterpreter } from '../runner';
import { isSafeRegexPattern } from '../runner/scan-utils';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import type { SopRule } from '../sop/_meta/sop-types';

/**
 * 内置 SOP 规则 presets 的可解释性守卫（2026-09-17 建立）
 *
 * 产品实际加载的是 src/sop/presets/sop-templates（cli 的 resolveBundledSopDir 优先取该目录），
 * 与 test-fixtures/sop-content/rules（单测专用简化 schema）是两份不同资产。
 *
 * 背景：presets 里曾有两条 active 规则（module-boundary / type-consistency）content 只有
 * check.rules 而缺 check.tool，落 ContentInterpreter 兜底 → 整份规则 JSON 当字面量搜源码
 * → 必然 0 命中 → 面板显示"通过"，实际从未执行任何检查。
 *
 * 本测试锁死该缺陷：任何 active 规则若无法解释为可执行指令，这里必须红。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

/** 内核可执行的指令类型（unresolved 不在其中，正是本测试要拦的） */
const EXECUTABLE_TYPES = new Set([
  'tool-dispatch',
  'pattern-scan',
  'forbidden',
  'forbidden-regex',
  'required-content',
  'layer-boundary',
  'check-list',
  'threshold',
  'scanner-dispatch',
  'preset',
]);

async function loadPresets(): Promise<{ registry: SopRegistry; rules: SopRule[] }> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return { registry, rules: registry.getActive() };
}

/** 取规则解释后的 forbidden-regex 正则清单（直接消费解释器产出，避免测试重复实现解析） */
function forbiddenRegexOf(rule: SopRule): string[] {
  const instr = new ContentInterpreter().interpret(rule);
  if (instr.type !== 'forbidden-regex') {
    throw new Error(`期望 forbidden-regex，实际 ${instr.type}（规则 ${rule.id}）`);
  }
  return instr.items.map((it) => it.regex);
}

describe('内置 SOP 规则 presets — 可解释性守卫', () => {
  it('没有 active 规则落 unresolved 兜底（防静默空跑）', async () => {
    const { rules } = await loadPresets();
    expect(rules.length).toBeGreaterThan(0);

    const interpreter = new ContentInterpreter();
    const unresolved = rules
      .map((rule) => ({ rule, instr: interpreter.interpret(rule) }))
      .filter(({ instr }) => instr.type === 'unresolved')
      .map(({ rule, instr }) =>
        instr.type === 'unresolved' ? `${rule.id} → ${instr.reason}` : rule.id,
      );

    expect(unresolved).toEqual([]);
  });

  it('每条 active 规则都解释为内核可执行的指令类型', async () => {
    const { rules } = await loadPresets();
    const interpreter = new ContentInterpreter();

    const unknown = rules
      .map((rule) => ({ id: rule.id, type: interpreter.interpret(rule).type }))
      .filter(({ type }) => !EXECUTABLE_TYPES.has(type));

    expect(unknown).toEqual([]);
  });

  // ─── 09-17 具体修复的回归锁定 ───────────────────────────

  it('module-boundary 已接内联评估器（forbidden-regex），正则能命中跨模块深引用', async () => {
    const { rules } = await loadPresets();
    const rule = rules.find((r) => r.id === 'inspect.scan.ironnest.module-boundary');
    expect(rule).toBeDefined();

    const regexes = forbiddenRegexOf(rule!);
    expect(regexes.length).toBeGreaterThanOrEqual(1);
    const re = new RegExp(regexes[0], 'g');

    // 正向：跨模块深引用内部文件（应命中）
    re.lastIndex = 0;
    expect(re.test(`import { X } from '../modules/user/user.service';`)).toBe(true);
    // 反向：引用模块 barrel（不应命中）
    re.lastIndex = 0;
    expect(re.test(`import { X } from '../modules/user';`)).toBe(false);
    // 反向：同模块内部相对引用（不含 modules/ 段，不应命中）
    re.lastIndex = 0;
    expect(re.test(`import { X } from './user.service';`)).toBe(false);
  });

  it('type-consistency 已接内联评估器（forbidden-regex），正则能命中 as any 断言', async () => {
    const { rules } = await loadPresets();
    const rule = rules.find((r) => r.id === 'inspect.scan.internal.type-consistency');
    expect(rule).toBeDefined();

    const regexes = forbiddenRegexOf(rule!);
    expect(regexes.length).toBeGreaterThanOrEqual(1);
    const asAny = new RegExp(regexes[0], 'g');

    expect(`const x = payload as any;`.match(asAny)).not.toBeNull();
    asAny.lastIndex = 0;
    expect(`const x = payload as string;`.match(asAny)).toBeNull();
  });

  // ─── T4（09-18）：7 条 inspect 域 draft 规则转正 ─────────────

  /**
   * 这 7 条规则原先用**不存在的伪 tool**（custom-ast-scanner / tsc-config-validator /
   * 结构不被识别的 dep-cruiser），status=draft 从未执行 —— 属「声明了却没查」。
   * T4 把它们改写为内核可解释形式并转 active，本用例锁死「转正 + 各接真实执行器」。
   */
  it('T4：原 7 条 draft 规则已转 active 且各自解释为真实可执行指令', async () => {
    const { rules } = await loadPresets();
    const expected: Record<string, string> = {
      'inspect.scan.depcruiser.layer-boundary': 'layer-boundary',
      'inspect.scan.depcruiser.module-dependency': 'tool-dispatch',
      'inspect.scan.ironnest.dependency-injection': 'forbidden-regex',
      'inspect.scan.internal.enum-usage': 'forbidden-regex',
      'inspect.scan.internal.null-safety': 'forbidden-regex',
      'inspect.scan.internal.strict-mode': 'required-content',
      'inspect.scan.internal.type-safety': 'forbidden-regex',
    };
    const interpreter = new ContentInterpreter();

    for (const [id, type] of Object.entries(expected)) {
      const rule = rules.find((r) => r.id === id);
      expect(rule, `规则 ${id} 应为 active（T4 转正）`).toBeDefined();
      expect(interpreter.interpret(rule!).type, `${id} 的执行器类型`).toBe(type);
    }
  });

  it('T4：inspect 域 active 规则覆盖 ≥ 11 条（原 4 条）', async () => {
    const { registry } = await loadPresets();
    const inspectActive = registry
      .getAll()
      .filter((r) => r.domain === 'inspect' && r.status === 'active');
    expect(inspectActive.length).toBeGreaterThanOrEqual(11);
  });

  it('规则声明的 forbidden-regex 不得被安全校验静默拒绝', async () => {
    // compileForbiddenRegexItems 对 isSafeRegexPattern 不通过的正则**静默跳过**：
    // 规则文件里明明写着检查项，运行时却一条都不查，且无任何提示 ——
    // 与「解释器兜底空跑」同类的第三次"声明了却没执行"。
    // 09-18 实证：初版 definite-assignment 正则含「分组 + 量词」被拒，测试才发现。
    const { rules } = await loadPresets();
    const interpreter = new ContentInterpreter();
    const rejected: string[] = [];

    for (const rule of rules) {
      const instr = interpreter.interpret(rule);
      if (instr.type !== 'forbidden-regex') continue;
      for (const item of instr.items) {
        if (!isSafeRegexPattern(item.regex)) rejected.push(`${rule.id} → ${item.regex}`);
      }
    }

    expect(rejected).toEqual([]);
  });
});

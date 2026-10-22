import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';
import { ruleMatchesProject } from '../sop/_meta/rule-project-match';
import type { SopRule } from '../sop/_meta/sop-types';

const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

async function loadRule(ruleId: string): Promise<SopRule> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  const rule = registry.get(ruleId);
  if (!rule) throw new Error(`预设中未找到规则 ${ruleId}`);
  return rule;
}

/**
 * strict-mode 是 TypeScript 独占栈规则：它要求项目根存在 tsconfig.json。
 * 若规则不带栈限定标签，ruleMatchesProject 会按"通用规则"恒保留，
 * 于是纯文档/资源型项目（无 package.json、无 tsconfig.json）也会被评估，
 * 并报出「缺少 tsconfig.json」的误报。
 * 这里锁定该规则必须携带 typescript 标签，并锁定按画像裁剪的实际效果。
 */
describe('strict-mode 规则的栈限定（随项目画像裁剪）', () => {
  it('内置 strict-mode 模板声明 typescript 栈限定标签', async () => {
    const rule = await loadRule('inspect.scan.internal.strict-mode');
    expect(rule.tags).toContain('typescript');
  });

  it('非 TypeScript 项目（无语言画像）裁剪掉 strict-mode 规则', async () => {
    const rule = await loadRule('inspect.scan.internal.strict-mode');
    expect(ruleMatchesProject(rule, { features: [] })).toBe(false);
  });

  it('TypeScript 项目仍保留 strict-mode 规则', async () => {
    const rule = await loadRule('inspect.scan.internal.strict-mode');
    expect(
      ruleMatchesProject(rule, { language: 'typescript', features: ['typescript'] }),
    ).toBe(true);
  });
});

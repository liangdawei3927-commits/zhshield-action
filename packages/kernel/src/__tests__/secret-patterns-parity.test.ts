import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import { SECRET_PATTERNS } from '@zh/shared';
import { SopRegistry } from '../sop/_meta/sop-registry';
import { SopLoader } from '../sop/_meta/sop-loader';

/**
 * 密钥检测规则「同源 + 覆盖」守卫（2026-09-18 建立，T8 口径统一）
 *
 * 门禁（L1 pre-commit）必须零外部二进制可跑，走 `@zh/shared` 的 `SECRET_PATTERNS` 纯正则；
 * 安全中心走 gitleaks 全量规则集（222 条）+ 工作区/git 历史/CI env 扩展范围。
 * 两者无法逐条相等——安全中心是门禁的**超集**，这是设计意图。
 *
 * 必须守住的是另一件事：门禁**不允许声明了却不实现**。规则
 * `guard.block.external.sensitive-info` 的 `standards.gitleaks` 列出了它声称拦截的
 * 类目，这些类目必须全部在 `SECRET_PATTERNS` 里有实现，否则门禁就是在报告里
 * 挂着一个它根本查不出的类目。
 */
const PRESETS_DIR = path.resolve(__dirname, '../sop/presets/sop-templates');

const GUARD_SECRET_RULE = 'guard.block.external.sensitive-info';

async function loadRegistry(): Promise<SopRegistry> {
  const registry = new SopRegistry();
  const loader = new SopLoader(registry, { rulesDir: PRESETS_DIR });
  await loader.loadFromFileSystem();
  return registry;
}

/** 读取规则声明的 gitleaks 规则 id 清单 */
function declaredGitleaksIds(content: Record<string, unknown>): string[] {
  const standards = (content.standards ?? {}) as Record<string, unknown>;
  const ids = standards.gitleaks;
  return Array.isArray(ids) ? ids.map(String) : [];
}

describe('密钥检测规则 — 门禁与安全中心同源', () => {
  it('门禁声明的 gitleaks 类目全部有正则实现（无「声明了却没查」）', async () => {
    const registry = await loadRegistry();
    const rule = registry.get(GUARD_SECRET_RULE);
    expect(rule, `规则 ${GUARD_SECRET_RULE} 未加载`).toBeDefined();

    const declared = declaredGitleaksIds(rule!.content);
    expect(declared.length).toBeGreaterThan(0);

    const implemented = new Set(SECRET_PATTERNS.map((p) => p.gitleaksId));
    const missing = declared.filter((id) => !implemented.has(id));
    expect(missing, `门禁声明了但未实现的密钥类目: ${missing.join(', ')}`).toEqual([]);
  });

  it('安全中心的扫描范围是门禁的超集或等集（反向不要求）', async () => {
    const registry = await loadRegistry();
    const central = registry.get('security.scan.gitleaks.hardcoded-key');
    expect(central, '安全中心硬编码密钥规则未加载').toBeDefined();

    const centralIds = declaredGitleaksIds(central!.content);
    const guardIds = declaredGitleaksIds(registry.get(GUARD_SECRET_RULE)!.content);
    // 门禁只拦暂存区的高置信类目，安全中心扫全量 + 历史 —— 门禁声明必须是子集
    const notCovered = guardIds.filter((id) => !centralIds.includes(id));
    expect(notCovered, `门禁声明的类目未被安全中心覆盖: ${notCovered.join(', ')}`).toEqual([]);
  });

  it('SECRET_PATTERNS 每一条都有 gitleaks 锚点（否则无法与安全中心对齐命名）', () => {
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern.gitleaksId, `${pattern.name} 缺 gitleaksId`).toBeTruthy();
    }
  });
});

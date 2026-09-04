import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { toFeatureFromProfile } from '@zh/fingerprint';
import { SopRegistry, SopLoader } from '@zh/kernel';
import { detectProjectProfile } from '../project-profile';

/**
 * M2 验收回归测试：画像驱动贯通（收敛桥）。
 *
 * 验证收敛后的唯一投影桥 toFeatureFromProfile 全链路：
 *   detectProjectProfile(fixture) → toFeatureFromProfile → kernel getRulesForProject
 * 使用 kernel 真实规则（src/sop/{guard,inspect,security}），断言对齐 M2 验收 1/2：
 *  - 画像贯通：ProjectFeature 与规则 tags 正确匹配 → 命中非空
 *  - security 域恒含：按画像过滤后 security 规则全部保留
 * 纯逻辑验证（不调外部工具），可在常规 pnpm test 中快速运行。
 */

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-probe-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture-app',
      dependencies: { '@nestjs/core': '^10.0.0' },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs' },
    }),
  );
  return dir;
}

// kernel 真实规则目录（src，非 dist）：SopLoader 默认 rulesDir 即 __dirname/.. = src/sop
const KERNEL_RULES_DIR = path.join(__dirname, '..', '..', '..', 'kernel', 'src', 'sop');

describe('M2 验收：画像驱动贯通（收敛桥）', () => {
  it('GIVEN NestJS+TS 项目 WHEN 收敛桥投影 THEN 产出 kernel 兼容 ProjectFeature', () => {
    const dir = makeFixture();
    try {
      const profile = detectProjectProfile(dir);
      const feature = toFeatureFromProfile(profile);

      expect(feature.language).toBe('typescript');
      expect(feature.framework).toBe('NestJS');
      // feature 语义复刻旧 deriveProjectFeature：language + 'typescript' + framework（原样大小写）
      expect(feature.features).toContain('typescript');
      // framework 按检测值原样入 features（'NestJS'）；kernel 侧 projectStack 会转小写匹配
      expect(feature.features).toContain('NestJS');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GIVEN 真实 kernel 规则 WHEN getRulesForProject(收敛桥 feature) THEN 命中非空且 security 恒含', async () => {
    const dir = makeFixture();
    try {
      const profile = detectProjectProfile(dir);
      const feature = toFeatureFromProfile(profile);

      const registry = new SopRegistry();
      const loader = new SopLoader(registry, { rulesDir: KERNEL_RULES_DIR });
      const total = await loader.loadFromFileSystem();
      expect(total).toBeGreaterThan(0);

      // 全量 domain 分布
      const active = registry.getActive();
      const byDomain = new Map<string, number>();
      for (const r of active) byDomain.set(r.domain, (byDomain.get(r.domain) ?? 0) + 1);
      const fullSecurity = byDomain.get('security') ?? 0;
      expect(fullSecurity).toBeGreaterThan(0);

      // 按画像过滤（真实匹配路径）
      const matched = loader.getRulesForProject(feature);
      const matchedByDomain = new Map<string, number>();
      for (const r of matched)
        matchedByDomain.set(r.domain, (matchedByDomain.get(r.domain) ?? 0) + 1);

      // 验收 1：命中非空
      expect(matched.length).toBeGreaterThan(0);

      // 验收 2：security 恒含（全部保留，不误删）
      expect(matchedByDomain.get('security') ?? 0).toBe(fullSecurity);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

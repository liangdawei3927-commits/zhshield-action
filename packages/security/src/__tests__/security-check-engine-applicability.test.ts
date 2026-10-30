import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { SecurityCheckEngine } from '../security-check-engine';

/**
 * 「不适用」语义的源点回归。
 *
 * 业务意图：无 Web 框架的项目没有装配 helmet/csrf 的位置，结论是「没得查」。
 * 若仍以普通 passed 返回，报告会虚增一条「已验证的安全能力」；若改为 failed，
 * 又会制造无法修复的假问题。必须用 applicability='not-applicable' 显式表达。
 */
describe('SecurityCheckEngine — helmet/csrf 不适用语义', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'zh-security-applicability-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 写 package.json（dependencies 可指定）到临时项目。
   * @param deps 依赖名 → 版本
   */
  function writePackageJson(deps: Record<string, string> = {}): void {
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps }),
      'utf-8',
    );
  }

  async function runChecks(checks: string[]) {
    const { results } = await new SecurityCheckEngine().run({
      mode: 'security',
      target: dir,
      checks,
      dryRun: false,
    });
    return results;
  }

  it('无 Web 框架：helmet 与 csrf 全部标为 not-applicable', async () => {
    writePackageJson({ 'left-pad': '1.0.0' });
    const results = await runChecks([
      'helmet-configured',
      'csrf-token-present',
      'same-site-cookie',
      'origin-header-validation',
    ]);

    expect(results).toHaveLength(4);
    for (const r of results) {
      // 不适用仍保持 passed（引擎契约不新增状态），但必须带 applicability 标记
      expect(r.status).toBe('passed');
      expect(r.applicability).toBe('not-applicable');
      expect(r.message).toContain('不适用');
    }
  });

  it('有 Web 框架但未装 helmet：helmet 是真实失败，不得标成不适用', async () => {
    writePackageJson({ express: '4.0.0' });
    const [helmet] = await runChecks(['helmet-configured']);

    // 这是可修复的真实缺口——标成「不适用」会掩盖问题
    expect(helmet.status).toBe('failed');
    expect(helmet.applicability).toBeUndefined();
  });

  it('有 Web 框架且已装 helmet：普通通过，不带上不适用标记', async () => {
    writePackageJson({ express: '4.0.0', helmet: '7.0.0' });
    const [helmet] = await runChecks(['helmet-configured']);

    expect(helmet.status).toBe('passed');
    expect(helmet.applicability).toBeUndefined();
  });
});

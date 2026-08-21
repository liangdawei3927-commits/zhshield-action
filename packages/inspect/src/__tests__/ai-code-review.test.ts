import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectProfile } from '@zh/dependency';
import { AiCodeReviewImpl } from '../ai-code/review';

function profile(projectPath: string): ProjectProfile {
  return { projectPath, language: 'typescript', framework: null, packageManager: 'pnpm', hasTypeScript: true };
}

describe('AiCodeReviewImpl', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-ai-review-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, content: string): Promise<void> {
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async function makeFixture(): Promise<void> {
    await writeFile('package.json', JSON.stringify({ name: 'f', dependencies: { lodash: '^4.17.21' } }));
    await writeFile(
      'src/app.ts',
      [
        "import 'lodahs';",
        "import { ghost } from 'ghost-pkg-xyz';",
        '',
        '// @ts-ignore',
        "const x: any = eval('1+1');",
        '',
        'try {',
        '  foo();',
        '} catch (e) {}',
        '',
      ].join('\n'),
    );
  }

  it('deepReview：幻觉依赖（抢注 critical）+ 不安全模式规则集', async () => {
    await makeFixture();
    const review = new AiCodeReviewImpl();
    const vulns = await review.deepReview(profile(tmpDir), {});

    const hallucinated = vulns.filter((v) => v.ruleId === 'ai-hallucinated-dependency');
    expect(hallucinated).toHaveLength(2);
    const critical = hallucinated.find((v) => v.severity === 'critical');
    expect(critical?.description).toContain('lodahs');

    const tsSuppression = vulns.find((v) => v.ruleId === 'ai-unsafe-default' && v.description.includes('@ts-ignore'));
    expect(tsSuppression?.line).toBe(4);
    expect(vulns.find((v) => v.description.includes('eval'))?.severity).toBe('high');
    expect(vulns.find((v) => v.description.includes('catch'))?.severity).toBe('medium');
  });

  it('deepReview：scope 过滤扫描范围', async () => {
    await makeFixture();
    const review = new AiCodeReviewImpl();
    expect(await review.deepReview(profile(tmpDir), { scope: ['src'] })).not.toHaveLength(0);
    expect(await review.deepReview(profile(tmpDir), { scope: ['other'] })).toHaveLength(0);
  });

  it('suggestFix：输出可被 07 协议消费（非空修复建议）', async () => {
    await makeFixture();
    const review = new AiCodeReviewImpl();
    const vulns = await review.deepReview(profile(tmpDir), {});
    const first = vulns[0];
    expect(first).toBeDefined();
    const fix = await review.suggestFix(first);
    expect(fix.length).toBeGreaterThan(0);
  });

  it('complianceReport：AI 占比基于标记结果，审计日志完整，策略恒空', async () => {
    await makeFixture();
    const review = new AiCodeReviewImpl();
    const report = await review.complianceReport(profile(tmpDir));

    expect(report.generatedAt).toBeDefined();
    expect(report.aiCodeRatio).toBeGreaterThanOrEqual(0);
    expect(report.aiCodeRatio).toBeLessThanOrEqual(1);
    expect(report.trend).toEqual({ period: 'week', delta: 0 });
    expect(report.auditLog).toHaveLength(1);
    expect(report.auditLog[0]?.action).toBe('ai-code-review');
    expect(report.policyViolations).toEqual([]);

    const srcModule = report.riskByModule.find((m) => m.module === 'src');
    expect(srcModule?.vulnCount).toBeGreaterThanOrEqual(5);
  });

  it('detectOrigin：无信号项目 → 空结果', async () => {
    await writeFile('src/plain.ts', 'export const a = 1;\n');
    const review = new AiCodeReviewImpl();
    expect(await review.detectOrigin(profile(tmpDir))).toHaveLength(0);
  });
});

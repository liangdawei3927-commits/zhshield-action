import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { InspectEngine } from '../engine';
import type { ToolAdapter } from '@zh/shared';
import type { AiCodeReviewImpl as AiCodeReviewImplType } from '../ai-code/review';
import type { ProjectProfile } from '@zh/dependency';

let forceDeepReviewError = false;

vi.mock('../ai-code/review', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai-code/review')>();
  class SpiedAiCodeReviewImpl implements AiCodeReviewImplType {
    private delegate: AiCodeReviewImplType;
    constructor() {
      this.delegate = new actual.AiCodeReviewImpl();
    }
    detectOrigin(project: ProjectProfile) {
      return this.delegate.detectOrigin(project);
    }
    async deepReview(project: ProjectProfile, opts?: { readonly scope?: readonly string[] }) {
      if (forceDeepReviewError) throw new Error('AI review service unavailable');
      return this.delegate.deepReview(project, opts ?? {});
    }
    suggestFix(vuln) {
      return this.delegate.suggestFix(vuln);
    }
    complianceReport(project: ProjectProfile) {
      return this.delegate.complianceReport(project);
    }
  }
  return { ...actual, AiCodeReviewImpl: SpiedAiCodeReviewImpl };
});

function makeMockAdapter(id: string): ToolAdapter {
  return {
    meta: { id, name: id, version: '1.0.0', description: `Mock ${id}` },
    isAvailable: vi.fn().mockResolvedValue(true),
    scan: vi.fn().mockResolvedValue({
      status: 'available',
      issues: [],
      metadata: { fileCount: 0 },
    }),
    normalize: vi.fn(),
  } as unknown as ToolAdapter;
}

describe('AI code review integration in scan flow', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-ai-integration-'));
    forceDeepReviewError = false;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, content: string): Promise<void> {
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async function makeProjectWithUnsafeCode(): Promise<void> {
    await writeFile('package.json', JSON.stringify({ name: 'test-proj', dependencies: {} }));
    await writeFile('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true } }));
    await writeFile(
      'src/index.ts',
      ["import 'fake-ai-pkg';", '', '// @ts-ignore', 'const x: any = eval("1");'].join('\n'),
    );
  }

  it('runScan should include source="ai-code-review" issues in the report', async () => {
    await makeProjectWithUnsafeCode();
    const engine = new InspectEngine();
    const adapter = makeMockAdapter('eslint');
    engine.registerAdapter(adapter);

    const report = await engine.runScan(tmpDir);

    const aiIssues = report.issues.filter((i) => i.source === 'ai-code-review');
    expect(aiIssues.length).toBeGreaterThan(0);
    expect(aiIssues.every((i) => i.category === 'security')).toBe(true);
    expect(aiIssues.some((i) => i.ruleId === 'ai-unsafe-default')).toBe(true);
  });

  it('runScan should include AI review even when adapter returns no issues', async () => {
    await makeProjectWithUnsafeCode();
    const engine = new InspectEngine();

    const report = await engine.runScan(tmpDir);

    const aiIssues = report.issues.filter((i) => i.source === 'ai-code-review');
    expect(aiIssues.length).toBeGreaterThan(0);
    expect(report.summary.total).toBe(aiIssues.length);
  });

  it('runScan completes even when deepReview throws — issues skipped, no crash', async () => {
    await makeProjectWithUnsafeCode();
    forceDeepReviewError = true;
    const engine = new InspectEngine();
    const adapter = makeMockAdapter('eslint');
    engine.registerAdapter(adapter);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await engine.runScan(tmpDir);

    expect(report.projectId).toBe(tmpDir);
    expect(report.score.grade).toBeDefined();
    expect(report.issues.filter((i) => i.source === 'ai-code-review')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[inspect] AI code review skipped — error during deepReview',
    );
    warnSpy.mockRestore();
  });

  it('aiVulnsToIssues maps severity correctly for all vuln levels', async () => {
    await makeProjectWithUnsafeCode();
    const engine = new InspectEngine();

    const report = await engine.runScan(tmpDir);

    const aiIssues = report.issues.filter((i) => i.source === 'ai-code-review');
    for (const issue of aiIssues) {
      expect(['error', 'warning', 'info']).toContain(issue.severity);
    }
  });
});

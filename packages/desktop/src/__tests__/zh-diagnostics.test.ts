import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport } from '@zh/kernel';
import type { PipelineReport } from '@zh/pipeline';
import {
  normalizePipelineReport,
  buildDiagnosticsReport,
  writeDiagnosticsFile,
  persistDiagnostics,
  persistDiagnosticsFromEntries,
  type DiagnosticEntry,
} from '../../electron/zh-diagnostics';

function makeGuardReport(): GuardReport {
  return {
    contractVersion: '1.0',
    mode: 'guard',
    profile: 'default',
    target: 'src',
    ok: false,
    dryRun: false,
    summary: { total: 1, passed: 0, failed: 1, warnings: 0, blocking: 1, errors: 0 },
    results: [
      {
        checkId: 'eslint',
        adapter: 'eslint',
        status: 'failed',
        severity: 'error',
        blocking: true,
        message: 'no-any 违规',
      },
      {
        checkId: 'gitleaks',
        adapter: 'gitleaks',
        status: 'passed',
        severity: 'info',
        blocking: false,
        message: 'ok',
      },
    ],
    generatedAt: '2026-07-31T00:00:00.000Z',
  };
}

function makeInspectionReport(): InspectionReport {
  return {
    projectId: 'proj-1',
    timestamp: new Date('2026-07-31T00:00:00.000Z'),
    scanType: 'full',
    duration: 100,
    score: { overall: 80, grade: 'B' },
    issues: [
      {
        id: 'iss-1',
        ruleId: 'typescript/no-any',
        severity: 'error',
        category: 'quality',
        message: '避免使用 any',
        file: 'src/app.service.ts',
        line: 15,
        column: 22,
        suggestion: '替换为具体类型',
        autoFixable: false,
        source: 'eslint',
        fingerprint: 'typescript/no-any:src/app.service.ts:15',
      },
    ],
    summary: { total: 1, error: 1, warning: 0, info: 0 },
    adapterResults: [],
    recommendations: [],
  };
}

function makeRefactorReport(): RefactorReport {
  return {
    timestamp: '2026-07-31T00:00:00.000Z',
    projectRoot: '/proj',
    totalFiles: 1,
    scannedFiles: 1,
    totalSmells: 1,
    byCategory: { structural: 1, coupling: 0, inheritance: 0 },
    bySeverity: { error: 1, warning: 0, info: 0 },
    files: [
      {
        filePath: 'src/order.service.ts',
        totalSmells: 1,
        maintainabilityScore: 60,
        refactorPriority: 'high',
        smells: [
          {
            id: 'smell-1',
            ruleId: 'complexity/high',
            category: 'structural',
            severity: 'warning',
            message: '函数复杂度过高',
            location: {
              filePath: 'src/order.service.ts',
              line: 42,
              column: 3,
              endLine: 42,
              endColumn: 30,
            },
            context: { metric: 'cyclomatic', value: 12, threshold: 10 },
            suggestion: {
              type: 'extract',
              description: '拆分为多个小函数',
              priority: 'high',
              effort: 'medium',
              autoFixable: false,
            },
          },
        ],
      },
    ],
    summary: { criticalFiles: 0, needsImmediateAction: 1, suggestionsByType: {} },
  };
}

function makeRuleEngineReport(): RuleEngineReport {
  return {
    total: 1,
    passed: 0,
    failed: 1,
    errors: 0,
    skipped: 0,
    ok: false,
    durationMs: 10,
    timestamp: new Date('2026-07-31T00:00:00.000Z'),
    evaluations: [
      {
        rule: {} as never,
        status: 'failed',
        message: '违反规则',
        files: ['src/main.ts'],
        violations: [
          {
            id: 'v-1',
            ruleId: 'security/no-eval',
            severity: 'high',
            file: 'src/main.ts',
            line: 8,
            column: 4,
            message: '禁止 eval',
            suggestion: '使用 JSON.parse',
          },
        ],
        durationMs: 5,
        targetEngine: 'inspect',
        timestamp: new Date('2026-07-31T00:00:00.000Z'),
      },
    ],
  };
}

function makePipeline(partial: Partial<PipelineReport> = {}): PipelineReport {
  return {
    timestamp: new Date('2026-07-31T00:00:00.000Z'),
    guard: null,
    inspect: null,
    refactor: null,
    passed: false,
    stage: 'complete',
    ...partial,
  };
}

describe('normalizePipelineReport', () => {
  it('提取 GuardReport 中未通过的检查，跳过 passed', () => {
    const issues = normalizePipelineReport(makePipeline({ guard: makeGuardReport() }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'eslint',
      severity: 'error',
      message: 'no-any 违规',
      file: '',
      source: 'guard',
    });
  });

  it('提取 InspectionReport 的完整 issue 字段', () => {
    const issues = normalizePipelineReport(makePipeline({ inspect: makeInspectionReport() }));
    expect(issues).toHaveLength(1);
    const issue = issues[0];
    expect(issue).toMatchObject({
      ruleId: 'typescript/no-any',
      severity: 'error',
      category: 'quality',
      message: '避免使用 any',
      file: 'src/app.service.ts',
      line: 15,
      column: 22,
      suggestion: '替换为具体类型',
      autoFixable: false,
      source: 'inspect',
      fingerprint: 'typescript/no-any:src/app.service.ts:15',
    });
  });

  it('提取 RefactorReport 的 smell，位置取自 location', () => {
    const issues = normalizePipelineReport(makePipeline({ refactor: makeRefactorReport() }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'complexity/high',
      severity: 'warning',
      file: 'src/order.service.ts',
      line: 42,
      suggestion: '拆分为多个小函数',
      source: 'refactor',
    });
  });

  it('RuleEngineReport 的 violation 被提取，high 映射为 error', () => {
    const issues = normalizePipelineReport(makePipeline({ guard: makeRuleEngineReport() }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      ruleId: 'security/no-eval',
      severity: 'error',
      file: 'src/main.ts',
      line: 8,
      suggestion: '使用 JSON.parse',
      source: 'guard',
    });
  });

  it('failed 但无 violations 的 evaluation 也生成诊断条目（用 message + files）', () => {
    const report: RuleEngineReport = {
      total: 1,
      passed: 0,
      failed: 1,
      errors: 0,
      skipped: 0,
      ok: false,
      durationMs: 5,
      timestamp: new Date('2026-07-31T00:00:00.000Z'),
      evaluations: [
        {
          rule: {} as never,
          status: 'failed',
          message: '依赖审计失败：存在 3 个已知漏洞',
          files: ['package.json'],
          durationMs: 5,
          targetEngine: 'guard',
          timestamp: new Date('2026-07-31T00:00:00.000Z'),
        },
      ],
    };
    const issues = normalizePipelineReport(makePipeline({ guard: report }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      message: '依赖审计失败：存在 3 个已知漏洞',
      file: 'package.json',
      source: 'guard',
      autoFixable: false,
    });
    expect(issues[0].ruleId).toBeTruthy();
  });

  it('空报告产出空数组', () => {
    expect(normalizePipelineReport(makePipeline())).toEqual([]);
  });
});

describe('buildDiagnosticsReport', () => {
  const issues: readonly DiagnosticEntry[] = [
    {
      ruleId: 'a/one',
      severity: 'error',
      category: 'quality',
      message: 'e1',
      file: 'src/a.ts',
      line: 1,
      column: 2,
      autoFixable: false,
      source: 'inspect',
      fingerprint: 'a/one:src/a.ts:1',
    },
    {
      ruleId: 'b/two',
      severity: 'warning',
      category: 'security',
      message: 'w1',
      file: 'src/b.ts',
      autoFixable: true,
      source: 'guard',
      fingerprint: 'b/two:src/b.ts:0',
    },
    {
      ruleId: 'c/three',
      severity: 'info',
      category: 'quality',
      message: 'i1',
      file: '',
      autoFixable: false,
      source: 'guard',
      fingerprint: 'c/three::0',
    },
  ];

  it('按文件分组生成 LSP 风格 files 视图，无位置的 issue 不进 files', () => {
    const report = buildDiagnosticsReport(
      { path: '/proj', name: 'proj' },
      issues,
      '2026-07-31T00:00:00.000Z',
    );
    expect(report.summary).toEqual({ total: 3, error: 1, warning: 1, info: 1 });
    expect(report.files).toHaveLength(2);
    expect(report.files[0].uri).toBe('file:///proj/src/a.ts');
    expect(report.files[0].diagnostics[0]).toMatchObject({
      severity: 1,
      code: 'a/one',
      source: 'zhshield',
      message: 'e1',
      range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
      data: { category: 'quality', autoFixable: false },
    });
    expect(report.files[1].diagnostics[0].severity).toBe(2);
  });
});

describe('writeDiagnosticsFile', () => {
  it('写入 .zhshield/diagnostics/latest.json 并返回绝对路径', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-diagnostics-'));
    try {
      const report = buildDiagnosticsReport(
        { path: project, name: 'tmp' },
        [],
        '2026-07-31T00:00:00.000Z',
      );
      const absPath = await writeDiagnosticsFile(report);
      expect(absPath).toBe(join(project, '.zhshield', 'diagnostics', 'latest.json'));
      expect(existsSync(absPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(absPath, 'utf-8'));
      expect(parsed.version).toBe('1.0');
      expect(parsed.project.path).toBe(project);
      expect(parsed.summary.total).toBe(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('persistDiagnostics', () => {
  it('一步完成归一化并落盘，返回绝对路径', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-persist-'));
    try {
      const absPath = await persistDiagnostics(
        project,
        makePipeline({ inspect: makeInspectionReport() }),
      );
      expect(absPath).toBe(join(project, '.zhshield', 'diagnostics', 'latest.json'));
      const parsed = JSON.parse(readFileSync(absPath, 'utf-8'));
      expect(parsed.project.name).toBe(basename(project));
      expect(parsed.summary.total).toBe(1);
      expect(parsed.issues[0]).toMatchObject({
        ruleId: 'typescript/no-any',
        file: 'src/app.service.ts',
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('persistDiagnosticsFromEntries whitelist 压制自检误报', () => {
  const entry = (ruleId: string, file: string, line?: number): DiagnosticEntry => ({
    ruleId,
    severity: 'error',
    category: 'security',
    message: ruleId,
    file,
    line,
    autoFixable: false,
    source: 'inspect',
    fingerprint: `${ruleId}:${file}:${line ?? 0}`,
  });

  it('白名单命中（rule+file）的误报被过滤，未命中条目保留', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-wl-'));
    try {
      // 构造与仓库自检一致的误报 + 一条不应被压制的真实条目
      mkdirSync(join(project, '.zhshield'), { recursive: true });
      writeFileSync(
        join(project, '.zhshield', 'whitelist.yml'),
        [
          'whitelist:',
          '  rule:',
          '    - rule: "ai-unsafe-default"',
          '      pattern: "src/adapters/security-scan-adapter.ts"',
          '      reason: "自检误报"',
        ].join('\n'),
      );
      const absPath = await persistDiagnosticsFromEntries(project, [
        entry('ai-unsafe-default', 'src/adapters/security-scan-adapter.ts', 21),
        entry('ai-hallucinated-dependency', 'packages/cli/vitest.config.js', 6),
        entry('ai-unsafe-default', 'src/real-bug.ts', 10),
      ]);
      const parsed = JSON.parse(readFileSync(absPath, 'utf-8'));
      expect(parsed.summary.total).toBe(2);
      expect(parsed.issues.map((i: { ruleId: string }) => i.ruleId)).toEqual([
        'ai-hallucinated-dependency',
        'ai-unsafe-default',
      ]);
      expect(parsed.issues.map((i: { file: string }) => i.file)).not.toContain(
        'src/adapters/security-scan-adapter.ts',
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('无 whitelist.yml 时不过滤任何条目（保持原行为）', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-wl-none-'));
    try {
      const absPath = await persistDiagnosticsFromEntries(project, [
        entry('ai-unsafe-default', 'src/adapters/security-scan-adapter.ts', 21),
      ]);
      const parsed = JSON.parse(readFileSync(absPath, 'utf-8'));
      expect(parsed.summary.total).toBe(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

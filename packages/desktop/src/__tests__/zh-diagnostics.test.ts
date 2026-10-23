import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import type { GuardReport } from '@zh/guard';
import type { InspectionReport } from '@zh/inspect';
import type { RefactorReport } from '@zh/refactor';
import type { RuleEngineReport } from '@zh/kernel';
import type { PipelineReport } from '@zh/pipeline';
import { buildTechDebtDashboard } from '@zh/scoring';
import {
  normalizePipelineReport,
  normalizeTechDebtSource,
  buildDiagnosticsReport,
  writeDiagnosticsFile,
  persistDiagnostics,
  persistDiagnosticsFromEntries,
  readDomainSnapshot,
  readAggregatedDiagnostics,
  domainSnapshotPath,
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

/**
 * 按域快照（T6 基础设施）。
 * 目的：latest.json 是整份覆盖写，谁最后跑就只有谁；技术债等跨域消费者
 * 需要「只读别域结果」的稳定入口，因此按域分文件落盘。
 */
describe('按域快照 domains/<source>.json', () => {
  const entries: DiagnosticEntry[] = [
    {
      ruleId: 'typescript/no-any',
      severity: 'warning',
      category: 'quality',
      message: 'w',
      file: 'src/a.ts',
      autoFixable: false,
      source: 'inspect',
      fingerprint: 'inspect::a',
    },
    {
      ruleId: 'secret/hardcoded',
      severity: 'error',
      category: 'security',
      message: 'e',
      file: 'src/b.ts',
      autoFixable: false,
      source: 'security',
      fingerprint: 'security::b',
    },
  ];

  it('写入时按 source 拆分落盘，各域互不覆盖', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-domain-snap-'));
    try {
      const report = buildDiagnosticsReport({ path: project, name: 'tmp' }, entries, 'T1');
      await writeDiagnosticsFile(report);

      const inspectSnap = JSON.parse(readFileSync(domainSnapshotPath(project, 'inspect'), 'utf-8'));
      const securitySnap = JSON.parse(
        readFileSync(domainSnapshotPath(project, 'security'), 'utf-8'),
      );
      expect(inspectSnap.issues).toHaveLength(1);
      expect(inspectSnap.issues[0].source).toBe('inspect');
      expect(securitySnap.issues).toHaveLength(1);
      expect(securitySnap.issues[0].source).toBe('security');
      // 快照路径确实在 domains/ 子目录下
      expect(domainSnapshotPath(project, 'inspect')).toBe(
        join(project, '.zhshield', 'diagnostics', 'domains', 'inspect.json'),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('readDomainSnapshot 读回同域快照；未落盘的域返回 null', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-domain-read-'));
    try {
      const report = buildDiagnosticsReport({ path: project, name: 'tmp' }, entries, 'T2');
      await writeDiagnosticsFile(report);

      const snap = await readDomainSnapshot(project, 'inspect');
      expect(snap).not.toBeNull();
      expect(snap!.generatedAt).toBe('T2');
      expect(snap!.issues.map((i) => i.fingerprint)).toEqual(['inspect::a']);

      // refactor 域本次没跑 → 必须返回 null（调用方据此显式提示，而非当成 0 问题）
      expect(await readDomainSnapshot(project, 'refactor')).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('快照损坏 / 结构不符 → 返回 null，不抛异常', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-domain-corrupt-'));
    try {
      mkdirSync(join(project, '.zhshield', 'diagnostics', 'domains'), { recursive: true });
      writeFileSync(domainSnapshotPath(project, 'inspect'), '{ not json', 'utf-8');
      expect(await readDomainSnapshot(project, 'inspect')).toBeNull();

      writeFileSync(domainSnapshotPath(project, 'inspect'), '{"version":"1.0"}', 'utf-8');
      expect(await readDomainSnapshot(project, 'inspect')).toBeNull();
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('单域落盘后 latest.json 仍为整份视图（不影响既有消费者）', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-domain-latest-'));
    try {
      await persistDiagnosticsFromEntries(project, entries);
      const latest = JSON.parse(
        readFileSync(join(project, '.zhshield', 'diagnostics', 'latest.json'), 'utf-8'),
      );
      expect(latest.issues).toHaveLength(2);
      expect((await readDomainSnapshot(project, 'inspect'))!.issues).toHaveLength(1);
      expect((await readDomainSnapshot(project, 'security'))!.issues).toHaveLength(1);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('快照足以直接生成技术债报告（T6：无需再触发一次巡检）', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-domain-debt-'));
    try {
      await persistDiagnosticsFromEntries(project, [
        {
          ruleId: 'architecture/layer',
          severity: 'warning',
          category: 'architecture',
          message: 'layer violation',
          file: 'src/a.ts',
          autoFixable: false,
          source: 'inspect',
          fingerprint: 'architecture::src/a.ts::layer',
        },
      ]);
      const snap = await readDomainSnapshot(project, 'inspect');
      expect(snap).not.toBeNull();
      const dashboard = buildTechDebtDashboard({
        projectId: project,
        issues: snap!.issues.map((e) => ({
          id: e.fingerprint,
          severity: e.severity,
          category: e.category,
          file: e.file,
        })),
        moduleHotness: [],
      });
      expect(dashboard.actionList.length).toBeGreaterThan(0);
      expect(dashboard.debtIndex).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

/**
 * 聚合读取（跨域完整性）。
 * 目的：latest.json 是整份覆盖写，单引擎扫描（refactor/guard/…）会把其他域的
 * 结果冲掉。聚合读取按域取最新一份合并，保证调用方看到完整治理视图而非
 * 最后一次运行的切片——否则 AI 只能拿到一个引擎的视角。
 */
describe('readAggregatedDiagnostics 跨域聚合', () => {
  const inspectEntry: DiagnosticEntry = {
    ruleId: 'typescript/no-any',
    severity: 'warning',
    category: 'quality',
    message: 'inspect 域条目',
    file: 'src/a.ts',
    autoFixable: false,
    source: 'inspect',
    fingerprint: 'inspect::a',
  };
  const securityEntry: DiagnosticEntry = {
    ruleId: 'secret/hardcoded',
    severity: 'error',
    category: 'security',
    message: 'security 域条目',
    file: 'src/b.ts',
    autoFixable: false,
    source: 'security',
    fingerprint: 'security::b',
  };
  const refactorEntry: DiagnosticEntry = {
    ruleId: 'duplicated-code',
    severity: 'info',
    category: 'structural',
    message: 'refactor 域条目',
    file: 'src/c.ts',
    autoFixable: false,
    source: 'refactor',
    fingerprint: 'refactor::c',
  };

  it('单引擎覆盖 latest.json 后，仍能读到其他域的既有结果', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-agg-merge-'));
    try {
      await persistDiagnosticsFromEntries(project, [inspectEntry, securityEntry], [
        'inspect',
        'security',
      ]);
      // 模拟单引擎扫描：latest.json 被 refactor 独占覆盖
      await persistDiagnosticsFromEntries(project, [refactorEntry], ['refactor']);

      const latest = JSON.parse(
        readFileSync(join(project, '.zhshield', 'diagnostics', 'latest.json'), 'utf-8'),
      );
      expect(latest.issues.map((i: DiagnosticEntry) => i.source)).toEqual(['refactor']);

      // 聚合后三个域必须在场
      const agg = await readAggregatedDiagnostics(project);
      expect(agg).not.toBeNull();
      expect(agg!.issues.map((i) => i.source).sort()).toEqual(['inspect', 'refactor', 'security']);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('同域以最新一份为准，不重复计入旧快照条目', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-agg-newest-'));
    try {
      await persistDiagnosticsFromEntries(project, [inspectEntry], ['inspect']);
      const newer: DiagnosticEntry = {
        ...inspectEntry,
        message: '新版条目',
        fingerprint: 'inspect::a2',
      };
      await persistDiagnosticsFromEntries(project, [newer], ['inspect']);

      const agg = await readAggregatedDiagnostics(project);
      expect(agg!.issues.map((i) => i.fingerprint)).toEqual(['inspect::a2']);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('无域快照目录时回退 latest.json', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-agg-fallback-'));
    try {
      const report = buildDiagnosticsReport({ path: project, name: 'tmp' }, [inspectEntry], 'T1');
      await writeDiagnosticsFile(report);
      rmSync(join(project, '.zhshield', 'diagnostics', 'domains'), { recursive: true, force: true });

      const agg = await readAggregatedDiagnostics(project);
      expect(agg!.issues).toHaveLength(1);
      expect(agg!.issues[0].fingerprint).toBe('inspect::a');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('全无数据时返回 null', async () => {
    const project = mkdtempSync(join(tmpdir(), 'zh-agg-empty-'));
    try {
      expect(await readAggregatedDiagnostics(project)).toBeNull();
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

describe('normalizeTechDebtSource', () => {
  const MODULES = [
    'packages/cli/src/index.ts',
    'packages/inspect/src/adapters/ts-prune-adapter.ts',
    'packages/kernel/src/runner/scan-utils.ts',
  ];

  function entriesFor(modules: string[], severity: 'error' | 'warning' | 'info' = 'error') {
    const dashboard = buildTechDebtDashboard({
      projectId: 'proj-1',
      issues: modules.map((file, i) => ({
        id: `i${i}`,
        severity,
        category: 'performance',
        file,
      })),
      moduleHotness: [],
    });
    return normalizeTechDebtSource(dashboard);
  }

  it('共享 9 字节前缀的模块产出不同 ruleId 与 fingerprint', () => {
    const entries = entriesFor(MODULES);
    expect(entries).toHaveLength(MODULES.length);
    expect(new Set(entries.map((e) => e.ruleId)).size).toBe(MODULES.length);
    expect(new Set(entries.map((e) => e.fingerprint)).size).toBe(MODULES.length);
  });

  it('file 回填为真实模块路径', () => {
    const entries = entriesFor(MODULES);
    expect(entries.map((e) => e.file).sort()).toEqual([...MODULES].sort());
    expect(entries.every((e) => e.file !== '')).toBe(true);
  });

  it('severity 由 severityFactor 还原，error 不再一律降级为 warning', () => {
    expect(entriesFor(MODULES, 'error').every((e) => e.severity === 'error')).toBe(true);
    expect(entriesFor(MODULES, 'warning').every((e) => e.severity === 'warning')).toBe(true);
    expect(entriesFor(MODULES, 'info').every((e) => e.severity === 'info')).toBe(true);
  });

  it('已处理动作不落盘', () => {
    const dashboard = buildTechDebtDashboard({
      projectId: 'proj-1',
      issues: [{ id: 'i0', severity: 'error', category: 'performance', file: MODULES[0] }],
      moduleHotness: [],
    });
    dashboard.actionList[0].status = 'repaid';
    expect(normalizeTechDebtSource(dashboard)).toHaveLength(0);
  });
});

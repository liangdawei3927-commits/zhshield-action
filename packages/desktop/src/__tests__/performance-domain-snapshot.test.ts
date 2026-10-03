import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { buildHealthDimensions } from '@zh/scoring';
import {
  normalizePerformanceData,
  persistDiagnosticsFromEntries,
  readDomainSnapshot,
  type DiagnosticEntry,
} from '../../electron/zh-diagnostics';
import { assembleHealthInputs, qualityFastPathScore } from '../../electron/report-summary';

/**
 * 性能扫描不得覆盖巡检快照（跨域数据损坏回归）
 *
 * 缺陷：runPerformanceHandler 以 ranSources=['inspect'] 落盘，而 normalizePerformanceData
 * 又给每条条目打 source:'inspect'。于是 `buildPerSourceEntries` 把它们全归进 inspect 桶，
 * `writeDomainSnapshots` 对 `domains/inspect.json` 做**整份覆盖写** → 跑一次性能扫描，
 * 真实巡检结果被 performance-only 条目顶掉（技术债指数 / quality 快路径 / 汇总输入全被污染）。
 *
 * 本文件锁定：performance 写自己的 `domains/performance.json`，inspect 快照原样保留；
 * 同时 performance 类条目对 quality 维的贡献不因分家而丢失。
 */

function entry(over: Partial<DiagnosticEntry>): DiagnosticEntry {
  return {
    ruleId: 'rule-x',
    severity: 'error',
    category: 'architecture',
    message: 'msg',
    file: 'src/a.ts',
    line: 1,
    autoFixable: false,
    source: 'inspect',
    fingerprint: 'fp-default',
    ...over,
  };
}

/** performance 引擎原始报告（normalizePerformanceData 的入参形状） */
function performanceReport() {
  return {
    issues: [
      {
        id: 'perf-1',
        ruleId: 'complexity.sync-io',
        severity: 'critical',
        file: 'src/b.ts',
        line: 7,
        message: '同步 IO',
        autoFixable: false,
      },
    ],
  };
}

describe('performance 扫描不得覆盖 inspect 域快照', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `zhshield-perf-domain-${crypto.randomUUID()}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('跑完性能扫描后 inspect 快照仍是巡检条目，performance 条目落到自己的域快照', async () => {
    // 先跑巡检
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ ruleId: 'architecture/layer', fingerprint: 'inspect::layer', source: 'inspect' })],
      ['inspect'],
    );
    expect((await readDomainSnapshot(projectDir, 'inspect'))?.issues).toHaveLength(1);

    // 再跑性能扫描
    const performanceEntries = normalizePerformanceData(performanceReport());
    await persistDiagnosticsFromEntries(projectDir, performanceEntries, ['performance']);

    // 巡检结果必须原样保留（此前被 performance-only 条目整份覆盖）
    const inspectSnap = await readDomainSnapshot(projectDir, 'inspect');
    expect(inspectSnap?.issues.map((i) => i.fingerprint)).toEqual(['inspect::layer']);
    expect(inspectSnap?.issues.every((i) => i.source === 'inspect')).toBe(true);

    // 性能结果落在自己的域快照里
    const perfSnap = await readDomainSnapshot(projectDir, 'performance');
    expect(perfSnap?.issues.map((i) => i.ruleId)).toEqual(['complexity.sync-io']);
    expect(perfSnap?.issues.every((i) => i.source === 'performance')).toBe(true);
  });

  it('技术债输入（读 inspect 快照）不再被性能扫描污染', async () => {
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ ruleId: 'architecture/layer', fingerprint: 'inspect::layer', source: 'inspect' })],
      ['inspect'],
    );
    await persistDiagnosticsFromEntries(projectDir, normalizePerformanceData(performanceReport()), [
      'performance',
    ]);

    const debtInput = await readDomainSnapshot(projectDir, 'inspect');
    expect(debtInput?.issues.map((i) => i.category)).toEqual(['architecture']);
  });
});

describe('performance 类条目对 quality 维的贡献不因分家而丢失', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `zhshield-perf-quality-${crypto.randomUUID()}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  async function persistBothDomains(): Promise<void> {
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ ruleId: 'architecture/layer', fingerprint: 'inspect::layer', source: 'inspect' })],
      ['inspect'],
    );
    await persistDiagnosticsFromEntries(projectDir, normalizePerformanceData(performanceReport()), [
      'performance',
    ]);
  }

  /** quality 维是否同时吃到了巡检与性能两类扣分 */
  function qualityOf(inspect: Parameters<typeof buildHealthDimensions>[0]['inspect']) {
    const dims = buildHealthDimensions({ guard: null, inspect });
    return dims.find((d) => d.name === 'quality');
  }

  it('assembleHealthInputs 并入 performance 快照的 performance 类条目', async () => {
    await persistBothDomains();

    const inputs = await assembleHealthInputs(projectDir, {
      listGuardReports: () => [],
      readDomainSnapshot,
      readDashboardState: async () => ({}),
      buildPipelineExtras: async () => ({}),
    });

    expect(inputs.inspectIssues?.map((i) => i.category)).toEqual(['architecture', 'performance']);

    // 两条 error 分属不同 ruleId → 各扣 8（S1 按规则聚合），ESLOC=0 时密度因子 = 1
    const quality = qualityOf(
      inputs.inspectIssues ? { issues: inputs.inspectIssues, esloc: inputs.esloc } : null,
    );
    expect(quality?.status).toBe('scored');
    expect(quality?.issues).toBe(2);
    expect(quality?.score).toBe(84);
    expect(inputs.timestamps.quality).not.toBeNull();
  });

  it('quality 快路径合并 performance 快照后与汇总路径同口径；无 performance 条目时零算分透传', async () => {
    await persistBothDomains();

    const inspectSnap = await readDomainSnapshot(projectDir, 'inspect');
    const perfSnap = await readDomainSnapshot(projectDir, 'performance');

    // 仅巡检数据 → 透传落盘时当场算好的分（不重算）
    expect(qualityFastPathScore(inspectSnap)).toMatchObject({
      score: 92,
      issues: 1,
      status: 'scored',
    });

    // 有 performance 条目 → 并集重算，与 assembleHealthInputs 喂给 quality 维的输入一致
    const merged = qualityFastPathScore(inspectSnap, perfSnap);
    expect(merged?.score).toBe(84);
    expect(merged?.issues).toBe(2);

    const inputs = await assembleHealthInputs(projectDir, {
      listGuardReports: () => [],
      readDomainSnapshot,
      readDashboardState: async () => ({}),
      buildPipelineExtras: async () => ({}),
    });
    const viaSummary = qualityOf(
      inputs.inspectIssues ? { issues: inputs.inspectIssues, esloc: inputs.esloc } : null,
    );
    expect(merged?.score).toBe(viaSummary?.score);
    expect(merged?.issues).toBe(viaSummary?.issues);
  });
});

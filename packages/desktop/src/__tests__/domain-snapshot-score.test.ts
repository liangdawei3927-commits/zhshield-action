import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { SCORE_VERSION } from '@zh/scoring';
import { computeDomainSnapshotScore } from '../../electron/domain-snapshot-score';
import {
  persistDiagnosticsFromEntries,
  readDomainSnapshot,
  type DiagnosticEntry,
  type DomainDimensionScore,
} from '../../electron/zh-diagnostics';
import { listDomainHistory } from '../../electron/domain-history';

/**
 * 四域快照当场出分（P2，2026-10-28）
 *
 * 背景：buildDomainSnapshot 仅对 inspect enrich dimensionScore，security/deps/
 * garbage/performance 四域 score=null → 域历史表「分数」列恒「—」。
 *
 * 双自证：
 * ① 真阳性——有问题的域必须扣分（且与 @zh/scoring 规范口径一致）；
 * ② not-run 不冒充——无数据时返回 undefined，快照不带分，绝不伪装满分（spec C）。
 */

function entry(over: Partial<DiagnosticEntry>): DiagnosticEntry {
  return {
    ruleId: 'rule-x',
    severity: 'error',
    category: 'security',
    message: 'msg',
    file: 'src/a.ts',
    line: 1,
    autoFixable: false,
    source: 'security',
    fingerprint: 'fp-default',
    ...over,
  };
}

describe('computeDomainSnapshotScore：security 维', () => {
  it('1 条 error 安全条目 = 93.1 分（softBand(1,8,48)，与规范 penaltyForIssues 同口径）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'security',
      entries: [entry({})],
      activeSecrets: 0,
    });
    expect(score).toBeDefined();
    expect(score?.dimension).toBe('security');
    expect(score?.score).toBe(93.1);
    expect(score?.issues).toBe(1);
    expect(score?.status).toBe('scored');
    expect(score?.version).toBe(SCORE_VERSION);
  });

  it('无条目 + secrets 未扫描 → undefined（not-run 不冒充分数）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'security',
      entries: [],
      activeSecrets: null,
    });
    expect(score).toBeUndefined();
  });

  it('0 条目 + 1 个 active 密钥 = 85 分（100-15，secretsPenalty 绝对扣分仍生效）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'security',
      entries: [],
      activeSecrets: 1,
    });
    expect(score?.score).toBe(85);
    expect(score?.issues).toBe(0); // P1-6：计数不并入 issues，只扣分
  });
});

describe('computeDomainSnapshotScore：dependencies 维', () => {
  it('1 条 warning 依赖条目 + 零漏洞 = 96.4 分（softBand(1,4,40)）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'dependencies',
      entries: [entry({ category: 'dependency', severity: 'warning', source: 'deps' })],
      deps: { vulnerabilities: { critical: 0, high: 0, medium: 0 }, upgradable: 0 },
    });
    expect(score?.score).toBe(96.4);
    expect(score?.issues).toBe(1);
  });

  it('0 条目 + 1 个 critical 漏洞 = 88 分（100-12，depsPenalty 绝对扣分）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'dependencies',
      entries: [],
      deps: { vulnerabilities: { critical: 1, high: 0, medium: 0 }, upgradable: 0 },
    });
    expect(score?.score).toBe(88);
    expect(score?.issues).toBe(0);
  });

  it('条目与 deps 全空 → undefined（not-run 不冒充分数）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'dependencies',
      entries: [],
      deps: null,
    });
    expect(score).toBeUndefined();
  });
});

describe('computeDomainSnapshotScore：performance / garbage 维（摘要计权）', () => {
  it('performance 全零 = 100 分；1 critical < 100', () => {
    const clean = computeDomainSnapshotScore({
      dimension: 'performance',
      performance: { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
    });
    expect(clean?.score).toBe(100);
    const bad = computeDomainSnapshotScore({
      dimension: 'performance',
      performance: { total: 1, bySeverity: { critical: 1, high: 0, medium: 0, low: 0, info: 0 } },
    });
    expect(bad?.score).toBeLessThan(100);
    expect(bad?.issues).toBe(1);
  });

  it('garbage 空 = 100 分；有垃圾 < 100', () => {
    const clean = computeDomainSnapshotScore({
      dimension: 'garbage',
      garbage: { total: 0, byType: {} },
    });
    expect(clean?.score).toBe(100);
    const bad = computeDomainSnapshotScore({
      dimension: 'garbage',
      garbage: { total: 3, byType: { 'build-artifact': 3 } },
    });
    expect(bad?.score).toBeLessThan(100);
    expect(bad?.issues).toBe(3);
  });
});

describe('computeDomainSnapshotScore：techdebt 维（100 − debtIndex）', () => {
  it('debtIndex 30 / 3 个动作 = 70 分（与 pipeline-score-p1b 规范口径一致）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'techdebt',
      techdebt: { debtIndex: 30, issueCount: 3 },
    });
    expect(score).toBeDefined();
    expect(score?.dimension).toBe('techdebt');
    expect(score?.score).toBe(70);
    expect(score?.issues).toBe(3);
    expect(score?.status).toBe('scored');
    expect(score?.version).toBe(SCORE_VERSION);
  });

  it('真跑了且债务指数为 0 → 满分 100（scored，不是 not-run）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'techdebt',
      techdebt: { debtIndex: 0, issueCount: 0 },
    });
    expect(score?.score).toBe(100);
    expect(score?.status).toBe('scored');
  });

  it('techdebt 为 null（未真跑，如无 inspect 快照）→ undefined，不冒充 100 分', () => {
    const score = computeDomainSnapshotScore({ dimension: 'techdebt', techdebt: null });
    expect(score).toBeUndefined();
  });
});

describe('computeDomainSnapshotScore：refactor 维（severity 计权）', () => {
  it('1 条 error 异味 = 93.1 分（softBand(1,8,48)，与规范 refactorPenalty 同口径）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'refactor',
      refactor: {
        totalSmells: 1,
        bySeverity: { error: 1, warning: 0, info: 0 },
        scannedFiles: 12,
      },
    });
    expect(score).toBeDefined();
    expect(score?.dimension).toBe('refactor');
    expect(score?.score).toBe(93.1);
    expect(score?.issues).toBe(1);
    expect(score?.status).toBe('scored');
    expect(score?.version).toBe(SCORE_VERSION);
  });

  it('扫了但零异味 = 满分 100（scored，不是 not-run）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'refactor',
      refactor: {
        totalSmells: 0,
        bySeverity: { error: 0, warning: 0, info: 0 },
        scannedFiles: 3,
      },
    });
    expect(score?.score).toBe(100);
    expect(score?.status).toBe('scored');
  });

  it('scannedFiles=0（纯 JS 项目，检测器没扫到文件）→ undefined，不冒充 100 分（P1-9）', () => {
    const score = computeDomainSnapshotScore({
      dimension: 'refactor',
      refactor: {
        totalSmells: 0,
        bySeverity: { error: 0, warning: 0, info: 0 },
        scannedFiles: 0,
      },
    });
    expect(score).toBeUndefined();
  });

  it('refactor 为 null（没跑过重构分析）→ undefined', () => {
    expect(computeDomainSnapshotScore({ dimension: 'refactor', refactor: null })).toBeUndefined();
  });
});

describe('refactor 域落盘接线（防回归：历史表「分数」列的唯一来源）', () => {
  it('分类页单独跑（runRefactorHandler）与体检流水线共用 refactorSnapshotScore', () => {
    const scanners = fs.readFileSync(
      path.join(__dirname, '../../electron/ipc/engines-scanners.ts'),
      'utf-8',
    );
    const engines = fs.readFileSync(path.join(__dirname, '../../electron/ipc/engines.ts'), 'utf-8');
    // 唯一实现：两处都调同一个函数，不得各自 computeDomainSnapshotScore 一份投影
    expect(scanners).toContain('const dimensionScore = refactorSnapshotScore(report);');
    expect(engines).toContain('refactorSnapshotScore(report.refactor)');
    expect(engines).not.toContain("dimension: 'refactor'");
  });
});

describe('techdebt 域落盘接线（防回归：历史表「分数」列的唯一来源）', () => {
  it('persistTechDebtDiagnostics 必须透传 dimensionScore', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../electron/ipc/engines-techdebt.ts'),
      'utf-8',
    );
    expect(src).toContain('dimensionScore ? { techdebt: dimensionScore } : undefined');
  });

  it('runTechDebtHandler 真跑分支必须带分落盘（空报告分支不得带分）', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../electron/ipc/engines-techdebt.ts'),
      'utf-8',
    );
    expect(src).toContain('persistTechDebtDiagnostics(projectPath, report, computeTechDebtScore(');
    // 全仓只有一处调用点（函数定义自身不算）：无 inspect 快照分支走 emptyTechDebtReport，
    // 若将来给它也补上带分落盘，这里会先红 —— 那是「没查」被写成 100 分
    expect(src.match(/await persistTechDebtDiagnostics\(/g)?.length ?? 0).toBe(1);
  });
});

describe('persistDiagnosticsFromEntries：dimensionScore 落快照 + 域历史', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `zhshield-domainscore-${crypto.randomUUID()}`);
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('带分写入：快照携带 dimensionScore，历史记录 score 非空', async () => {
    const dimensionScore: DomainDimensionScore = {
      dimension: 'security',
      score: 92,
      issues: 1,
      status: 'scored',
      version: SCORE_VERSION,
    };
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ fingerprint: 'fp-1' })],
      ['security'],
      { security: dimensionScore },
    );
    const snap = await readDomainSnapshot(projectDir, 'security');
    expect(snap?.dimensionScore).toEqual(dimensionScore);

    const records = await listDomainHistory(projectDir, 'security', 10);
    expect(records.length).toBe(1);
    expect(records[0].score).toBe(92);
    expect(records[0].scoreVersion).toBe(SCORE_VERSION);
  });

  it('techdebt 域带分写入：历史 score 非空（分类页历史表不再恒「—」）', async () => {
    const dimensionScore: DomainDimensionScore = {
      dimension: 'techdebt',
      score: 70,
      issues: 3,
      status: 'scored',
      version: SCORE_VERSION,
    };
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ source: 'techdebt', category: 'techdebt:quality', fingerprint: 'fp-3' })],
      ['techdebt'],
      { techdebt: dimensionScore },
    );
    const snap = await readDomainSnapshot(projectDir, 'techdebt');
    expect(snap?.dimensionScore).toEqual(dimensionScore);

    const records = await listDomainHistory(projectDir, 'techdebt', 10);
    expect(records[0].score).toBe(70);
    expect(records[0].scoreVersion).toBe(SCORE_VERSION);
  });

  it('refactor 域带分写入：历史 score 非空（分类页历史表不再恒「—」）', async () => {
    const dimensionScore: DomainDimensionScore = {
      dimension: 'refactor',
      score: 93.1,
      issues: 1,
      status: 'scored',
      version: SCORE_VERSION,
    };
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ source: 'refactor', category: 'refactor', fingerprint: 'fp-4' })],
      ['refactor'],
      { refactor: dimensionScore },
    );
    const snap = await readDomainSnapshot(projectDir, 'refactor');
    expect(snap?.dimensionScore).toEqual(dimensionScore);

    const records = await listDomainHistory(projectDir, 'refactor', 10);
    expect(records[0].score).toBe(93.1);
    expect(records[0].scoreVersion).toBe(SCORE_VERSION);
  });

  it('不带分写入（如 guard）：快照无 dimensionScore，历史 score=null（向后兼容不回归）', async () => {
    await persistDiagnosticsFromEntries(
      projectDir,
      [entry({ source: 'guard', category: 'quality', fingerprint: 'fp-2' })],
      ['guard'],
    );
    const snap = await readDomainSnapshot(projectDir, 'guard');
    expect(snap?.dimensionScore).toBeUndefined();

    const records = await listDomainHistory(projectDir, 'guard', 10);
    expect(records[0].score).toBeNull();
  });
});

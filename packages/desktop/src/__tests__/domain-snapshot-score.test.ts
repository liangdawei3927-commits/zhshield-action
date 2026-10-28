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

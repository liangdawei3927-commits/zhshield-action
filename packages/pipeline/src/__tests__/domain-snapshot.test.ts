import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  domainSnapshotPath,
  readDomainSnapshot,
  loadGuardConclusions,
  type DiagnosticsReport,
} from '../domain-snapshot';

/**
 * 域快照只读入口（《07》A6 / C4）。
 *
 * 锁三件事：
 *   1. 快照落盘格式由 pipeline 单一实现，CLI 与桌面端读同一份文件；
 *   2. 「读不到」必须返回 null，**不得**当成「0 个问题」——否则门禁会以「零问题」判通过；
 *   3. 结论集只取门禁的三个供应商域，缺域 = 本次未运行（C4：skipped，不判通过）。
 */
describe('domain-snapshot — 域快照读取与门禁结论装配', () => {
  let project: string;

  const makeReport = (issues: DiagnosticsReport['issues']): DiagnosticsReport => ({
    version: '1.0',
    project: { path: project, name: 'demo' },
    generatedAt: '2026-11-01T00:00:00.000Z',
    summary: { total: issues.length, error: 0, warning: 0, info: 0 },
    issues,
    files: [],
  });

  const writeSnapshot = async (
    source: 'inspect' | 'security' | 'deps' | 'refactor',
    payload: unknown,
  ): Promise<void> => {
    const path = domainSnapshotPath(project, source);
    await mkdir(join(project, '.zhshield', 'diagnostics', 'domains'), { recursive: true });
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  };

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), 'zhshield-domain-snapshot-'));
  });

  afterEach(async () => {
    await rm(project, { recursive: true, force: true });
  });

  it('Given 某域已落盘快照，When 读取该域，Then 原样返回报告', async () => {
    const report = makeReport([
      {
        ruleId: 'inspect.official.no-console',
        severity: 'warning',
        category: 'style',
        message: '发现 console',
        file: 'src/index.ts',
        line: 3,
        autoFixable: false,
        fingerprint: 'fp-1',
        source: 'inspect',
      },
    ]);
    await writeSnapshot('inspect', report);

    expect(await readDomainSnapshot(project, 'inspect')).toEqual(report);
  });

  it('Given 未落盘 / JSON 损坏 / 结构不符，When 读取，Then 一律返回 null（不得当成零问题）', async () => {
    expect(await readDomainSnapshot(project, 'inspect')).toBeNull();

    const path = domainSnapshotPath(project, 'security');
    await mkdir(join(project, '.zhshield', 'diagnostics', 'domains'), { recursive: true });
    await writeFile(path, '{ not json', 'utf-8');
    expect(await readDomainSnapshot(project, 'security')).toBeNull();

    await writeFile(path, JSON.stringify({ version: '1.0', project: {} }), 'utf-8');
    expect(await readDomainSnapshot(project, 'security')).toBeNull();
  });

  it('Given 三个供应商域均有快照，When 装配门禁结论集，Then 只含 inspect/security/deps 且字段原样搬迁', async () => {
    await writeSnapshot(
      'inspect',
      makeReport([
        {
          ruleId: 'inspect.official.no-any',
          severity: 'error',
          category: 'type',
          message: 'any 滥用',
          file: 'src/a.ts',
          line: 10,
          column: 2,
          suggestion: '改用具体类型',
          autoFixable: false,
          fingerprint: 'fp-a',
          source: 'inspect',
        },
      ]),
    );
    await writeSnapshot(
      'security',
      makeReport([
        {
          ruleId: 'secret:aws-key',
          severity: 'error',
          category: 'secret',
          message: '疑似密钥',
          file: 'config.ts',
          autoFixable: false,
          fingerprint: 'fp-b',
          source: 'security',
        },
      ]),
    );
    await writeSnapshot('deps', makeReport([]));

    const conclusions = await loadGuardConclusions(project);

    expect(Object.keys(conclusions).sort()).toEqual(['deps', 'inspect', 'security']);
    expect(conclusions.inspect?.generatedAt).toBe('2026-11-01T00:00:00.000Z');
    // 可选字段缺失时不得写成 undefined 键（下游按「是否存在」判语义）
    expect(conclusions.security?.issues[0]).toEqual({
      ruleId: 'secret:aws-key',
      severity: 'error',
      file: 'config.ts',
      message: '疑似密钥',
    });
    expect(conclusions.inspect?.issues[0]).toMatchObject({
      ruleId: 'inspect.official.no-any',
      line: 10,
      column: 2,
      suggestion: '改用具体类型',
    });
  });

  it('Given 只有非供应商域（refactor）快照，When 装配结论集，Then 仍是空对象而非缺省 undefined', async () => {
    await writeSnapshot('refactor', makeReport([]));

    expect(await loadGuardConclusions(project)).toEqual({});
  });
});

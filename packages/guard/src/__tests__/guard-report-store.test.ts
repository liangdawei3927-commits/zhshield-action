import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  appendGuardReport,
  listGuardReports,
  guardReportsPath,
  deriveRiskLevel,
  type GuardReportRecord,
} from '../guard-report-store';

let tmpDir: string;

function makeRecord(overrides: Partial<GuardReportRecord> = {}): GuardReportRecord {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    triggerSource: 'pre-commit',
    ok: false,
    riskLevel: 'high',
    summary: { total: 3, passed: 1, failed: 1, warnings: 1, blocking: 1, errors: 0 },
    checks: [
      {
        checkId: 'eslint',
        adapter: 'eslint-check',
        status: 'failed',
        severity: 'error',
        blocking: true,
        message: 'TS 类型错误',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-store-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('guard-report-store', () => {
  it('append 后可在 <project>/.zhshield/guard-reports.jsonl 找到记录', () => {
    const record = makeRecord();
    const absPath = appendGuardReport(tmpDir, record);

    expect(absPath).toBe(guardReportsPath(tmpDir));
    expect(fs.existsSync(absPath)).toBe(true);

    const lines = fs.readFileSync(absPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ triggerSource: 'pre-commit', riskLevel: 'high' });
  });

  it('list 返回新→旧顺序', () => {
    appendGuardReport(
      tmpDir,
      makeRecord({ timestamp: '2026-01-01T00:00:00.000Z', triggerSource: 'pre-commit' }),
    );
    appendGuardReport(
      tmpDir,
      makeRecord({ timestamp: '2026-01-02T00:00:00.000Z', triggerSource: 'pre-push' }),
    );

    const records = listGuardReports(tmpDir);
    expect(records.map((r) => r.triggerSource)).toEqual(['pre-push', 'pre-commit']);
  });

  it('limit 生效，超出只取最近 N 条', () => {
    for (let i = 1; i <= 5; i++) {
      appendGuardReport(
        tmpDir,
        makeRecord({ timestamp: `2026-01-0${i}T00:00:00.000Z`, triggerSource: `hook-${i}` }),
      );
    }
    const records = listGuardReports(tmpDir, 2);
    expect(records).toHaveLength(2);
    expect(records[0].triggerSource).toBe('hook-5');
    expect(records[1].triggerSource).toBe('hook-4');
  });

  it('文件不存在时返回空数组', () => {
    expect(listGuardReports(tmpDir)).toEqual([]);
  });

  it('损坏行被跳过，不阻塞历史读取', () => {
    appendGuardReport(tmpDir, makeRecord({ triggerSource: 'good-1' }));
    fs.appendFileSync(guardReportsPath(tmpDir), '{broken json}\n', 'utf-8');
    appendGuardReport(tmpDir, makeRecord({ triggerSource: 'good-2' }));

    const records = listGuardReports(tmpDir, 10);
    expect(records.map((r) => r.triggerSource)).toEqual(['good-2', 'good-1']);
  });

  it('超过 MAX_RECORDS 时截断，只保留最近记录', () => {
    for (let i = 1; i <= 120; i++) {
      appendGuardReport(
        tmpDir,
        makeRecord({
          timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          triggerSource: `h-${i}`,
        }),
      );
    }
    const records = listGuardReports(tmpDir, 200);
    expect(records).toHaveLength(100);
    expect(records[0].triggerSource).toBe('h-120');
  });
});

describe('deriveRiskLevel', () => {
  it('有拦截/失败 → high', () => {
    expect(
      deriveRiskLevel({ total: 2, passed: 0, failed: 1, warnings: 0, blocking: 1, errors: 0 }),
    ).toBe('high');
    expect(
      deriveRiskLevel({ total: 2, passed: 0, failed: 1, warnings: 0, blocking: 0, errors: 0 }),
    ).toBe('high');
  });

  it('有警告/错误 → medium', () => {
    expect(
      deriveRiskLevel({ total: 2, passed: 1, failed: 0, warnings: 1, blocking: 0, errors: 0 }),
    ).toBe('medium');
    expect(
      deriveRiskLevel({ total: 2, passed: 1, failed: 0, warnings: 0, blocking: 0, errors: 1 }),
    ).toBe('medium');
  });

  it('全部通过 → low', () => {
    expect(
      deriveRiskLevel({ total: 2, passed: 2, failed: 0, warnings: 0, blocking: 0, errors: 0 }),
    ).toBe('low');
  });
});

/**
 * 第 3 批回归（实测报告 2026-10-27）：
 * - P1-5 门禁结果定位透传（GuardReport 分支从 details 提取 file/line 拼进 message）；
 * - P1-3 添加向导离线超时（withOfflineTimeout 到点放弃等待按离线继续）。
 */
import { describe, it, expect } from 'vitest';
import { normalizeGuardSource } from '../../electron/zh-diagnostics-normalize';
import type { GuardReport } from '@zh/guard';
import { withOfflineTimeout } from '../components/onboarding/ProjectOnboardingPage-utils';

/** 构造最小 GuardReport：单条非 passed 检查项 */
function guardReportWith(
  details: unknown,
  message = '扫描器发现 1 个问题',
): GuardReport {
  return {
    contractVersion: 'p0.v1',
    mode: 'manual',
    profile: 'all',
    target: 'repo',
    ok: false,
    dryRun: false,
    summary: { total: 1, passed: 0, failed: 1, warnings: 1, blocking: 1, errors: 0 },
    results: [
      {
        checkId: 'guard.block.external.security-scan',
        adapter: 'sop-engine',
        status: 'failed',
        severity: 'warning',
        blocking: true,
        message,
        details,
      },
    ],
    generatedAt: 'T0',
  } as unknown as GuardReport;
}

describe('P1-5 门禁结果带文件定位', () => {
  it('SOP 路径（details.violations）：file/line 透传 + message 附定位明细', () => {
    const entries = normalizeGuardSource(
      guardReportWith({
        violations: [
          { file: 'src/index.js', line: 2, message: '疑似硬编码凭据' },
          { file: 'src/other.js', message: '第二条' },
        ],
      }),
    );
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.file).toBe('src/index.js');
    expect(e.line).toBe(2);
    expect(e.message).toContain('src/index.js:2 疑似硬编码凭据');
    expect(e.message).toContain('src/other.js 第二条');
  });

  it('传统 adapter 路径（details.findings）：同样透传定位', () => {
    const entries = normalizeGuardSource(
      guardReportWith({
        findings: [{ file: 'src/a.ts', line: 10, message: 'eval 调用' }],
      }),
    );
    expect(entries[0].file).toBe('src/a.ts');
    expect(entries[0].line).toBe(10);
  });

  it('无明细（旧格式）：保持旧行为 file 为空、message 原样', () => {
    const entries = normalizeGuardSource(guardReportWith(undefined));
    expect(entries[0].file).toBe('');
    expect(entries[0].line).toBeUndefined();
    expect(entries[0].message).toBe('扫描器发现 1 个问题');
  });

  it('明细超上限时截断并给出总数', () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      file: `f${i}.js`,
      line: i + 1,
      message: 'x',
    }));
    const entries = normalizeGuardSource(guardReportWith({ violations: items }));
    expect(entries[0].message).toContain('等共 25 条');
    expect(entries[0].message).not.toContain('f24.js');
  });

  it('passed 检查项不产条目（既有行为不回退）', () => {
    const report = guardReportWith({ violations: [] });
    report.results[0].status = 'passed';
    expect(normalizeGuardSource(report)).toHaveLength(0);
  });
});

describe('P1-3 向导离线超时（withOfflineTimeout）', () => {
  it('正常完成：透传结果不等待超时', async () => {
    const result = await withOfflineTimeout(Promise.resolve('ok'), () => 'fallback', 5_000);
    expect(result).toBe('ok');
  });

  it('挂起的 Promise 到点落 fallback（离线继续）', async () => {
    const start = Date.now();
    const result = await withOfflineTimeout(
      new Promise<string>(() => {}), // 永不 settle（模拟云端不可达）
      () => 'offline',
      30,
    );
    expect(result).toBe('offline');
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it('reject 的 Promise 立即落 fallback（快速失败不额外等待）', async () => {
    const result = await withOfflineTimeout(
      Promise.reject(new Error('ECONNREFUSED')),
      () => 'offline',
      30_000,
    );
    expect(result).toBe('offline');
  });

  it('undefined 输入（API 缺失）：直接落 fallback', async () => {
    const result = await withOfflineTimeout<string | undefined>(
      undefined,
      () => undefined,
      30,
    );
    expect(result).toBeUndefined();
  });
});

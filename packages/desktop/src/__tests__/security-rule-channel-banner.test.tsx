import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { SecurityRuleChannelBanner } from '../pages/security-report-parts';
import type { SecurityScanReportData } from '../types/electron';

/**
 * R7：规则通道求值账按两个桶分开呈现。
 *
 * 混桶（degraded 与 skipped 拼进同一条黄条）会把「本项目不需要」渲染成「出问题了」，
 * 用户会按「装工具/重跑」去做无效动作，并让真实降级淹没成背景噪音。
 */
const t = (key: string, params?: Record<string, unknown>): string => {
  const fallback = (params?.defaultValue as string | undefined) ?? key;
  return Object.entries(params ?? {})
    .filter(([k]) => k !== 'defaultValue')
    .reduce((acc, [k, v]) => acc.replace(new RegExp(`{{${k}}}`, 'g'), String(v)), fallback);
};

function render(report: SecurityScanReportData): string {
  return renderToStaticMarkup(<SecurityRuleChannelBanner report={report} t={t} />);
}

const base: SecurityScanReportData = {
  summary: { total: 0, critical: 0, high: 0, medium: 0, low: 0, malwareTotal: 0 },
  findings: [],
  malware: [],
  securityScore: 100,
  metadata: { duration: 0, timestamp: '2026-11-11T01:01:01.000Z' },
};

describe('SecurityRuleChannelBanner — degraded / skipped 分桶', () => {
  it('只有 skipped（按项目前提跳过）→ 中性条，不出警示色', () => {
    const markup = render({
      ...base,
      ruleChannel: { ran: true, skipped: 2, degraded: 0 },
      ruleLedger: [
        {
          ruleId: 'inspect.scan.typescript.type-error-check',
          name: 'tsc',
          status: 'skipped',
          reason: '工具 tsc 不在当前项目画像 scope 内',
        },
        {
          ruleId: 'inspect.scan.external.eslint-rules',
          name: 'eslint',
          status: 'skipped',
          reason: '工具 eslint 不在当前项目画像 scope 内',
        },
      ],
    });

    expect(markup).toContain('info-50');
    expect(markup).not.toContain('warning-50');
    expect(markup).toContain('2 条规则按项目前提跳过');
    expect(markup).toContain('inspect.scan.typescript.type-error-check');
  });

  it('有 degraded → 警示色 + 逐条 ruleId 与原因', () => {
    const markup = render({
      ...base,
      ruleChannel: { ran: true, skipped: 0, degraded: 1 },
      ruleLedger: [
        {
          ruleId: 'inspect.scan.external.dependency-audit',
          name: 'Dependency Security Audit',
          status: 'skipped',
          degraded: true,
          reason: '所有扫描器不可用: npm-audit(未注册工具适配器)',
        },
      ],
    });

    expect(markup).toContain('warning-50');
    expect(markup).toContain('1 条规则未能评估');
    expect(markup).toContain('inspect.scan.external.dependency-audit');
    expect(markup).toContain('所有扫描器不可用');
  });

  it('error 状态计入「未能评估」桶', () => {
    const markup = render({
      ...base,
      ruleChannel: { ran: true, skipped: 0, degraded: 1 },
      ruleLedger: [{ ruleId: 'security.scan.dead', name: 'dead', status: 'error', reason: 'engine boom' }],
    });

    expect(markup).toContain('warning-50');
    expect(markup).toContain('security.scan.dead');
    expect(markup).toContain('engine boom');
  });

  it('通道未执行 → danger 条', () => {
    const markup = render({
      ...base,
      ruleChannel: { ran: false, skipped: 0, degraded: 0 },
    });

    expect(markup).toContain('danger-50');
    expect(markup).toContain('规则通道本次未执行');
  });

  it('旧报告只有计数、无明细 → 警示条但明确标注「逐条明细未知」', () => {
    const markup = render({
      ...base,
      ruleChannel: { ran: true, skipped: 0, degraded: 6 },
    });

    expect(markup).toContain('warning-50');
    expect(markup).toContain('6 条规则未能评估');
    expect(markup).toContain('逐条明细未知');
  });

  it('全部求值成功 → 不渲染任何条', () => {
    const markup = render({
      ...base,
      ruleChannel: { ran: true, skipped: 0, degraded: 0 },
      ruleLedger: [{ ruleId: 'security.scan.ok', name: 'ok', status: 'passed' }],
    });

    expect(markup).toBe('');
  });
});

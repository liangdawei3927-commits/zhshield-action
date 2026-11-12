import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { evaluateComplianceBaseline } from '../compliance/baseline';
import { ComplianceSummaryCard } from '../pages/compliance-parts';

/**
 * 安全中心主页的合规摘要卡：只暴露计数与失败条款，逐条依据留在详情页。
 *
 * 锁定的不变量：
 *   1. 失败条款必须点名（不是只给一个失败计数）；
 *   2. 「查看合规详情」只在有跳转动作时渲染（没有入口就不放死按钮）。
 */
describe('ComplianceSummaryCard', () => {
  const clean = evaluateComplianceBaseline({ security: null, deps: null });

  it('渲染标准名、覆盖计数与详情入口', () => {
    const markup = renderToStaticMarkup(
      <ComplianceSummaryCard report={clean} onOpen={() => {}} />,
    );
    expect(markup).toContain('合规基线');
    expect(markup).toContain('有证据覆盖 0 / 14');
    expect(markup).toContain('缺证据 14');
    expect(markup).toContain('查看合规详情');
  });

  it('失败条款按名称点出（最多三条）', () => {
    const report = evaluateComplianceBaseline({
      security: {
        ledger: [
          { ruleId: 'security.scan.semgrep.sql-injection', status: 'failed' },
          { ruleId: 'security.scan.internal.tls-config', status: 'failed' },
          { ruleId: 'security.scan.internal.header-config', status: 'failed' },
        ],
        malwareTotal: 0,
        generatedAt: new Date().toISOString(),
      },
      deps: null,
    });
    const markup = renderToStaticMarkup(
      <ComplianceSummaryCard report={report} onOpen={() => {}} />,
    );
    expect(markup).toContain('失败 3');
    expect(markup).toContain('注入类漏洞');
    expect(markup).toContain('安全响应头取值');
  });

  it('没有 onOpen 时不渲染详情按钮', () => {
    const markup = renderToStaticMarkup(<ComplianceSummaryCard report={clean} />);
    expect(markup).not.toContain('查看合规详情');
  });
});

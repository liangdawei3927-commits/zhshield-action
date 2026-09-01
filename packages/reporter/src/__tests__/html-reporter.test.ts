import { describe, it, expect } from 'vitest';
import { generateHtmlReport, type HtmlReportData, type HtmlReportOptions } from '../html-reporter';

describe('generateHtmlReport — HTML 报告生成', () => {
  const baseData: HtmlReportData = {
    timestamp: '2026-07-29T10:00:00.000Z',
    projectName: 'my-project',
    summary: {
      total: 10,
      passed: 8,
      warnings: 1,
      failures: 1,
    },
    sections: [
      {
        title: 'Security',
        items: [
          {
            status: 'fail',
            message: 'Hardcoded API key',
            file: 'src/config.ts',
            line: 5,
            severity: 'high',
          },
          { status: 'pass', message: 'No SQL injection', file: 'src/db.ts', line: 12 },
        ],
      },
    ],
  };

  // ─── 基本 HTML 结构 ─────────────────────────────────

  it('1. generateHtmlReport: 返回有效 HTML 文档', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="UTF-8">');
  });

  it('2. generateHtmlReport: 包含项目名称', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('my-project');
    expect(html).toContain('Project: my-project');
  });

  it('3. generateHtmlReport: 包含标题', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('CodeShield Report');
  });

  it('4. generateHtmlReport: 包含时间戳', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('2026-07-29T10:00:00.000Z');
  });

  // ─── 统计数字 ─────────────────────────────────────────

  it('5. generateHtmlReport: 统计卡片包含所有数字', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('Total Checks');
    expect(html).toContain('Passed');
    expect(html).toContain('Warnings');
    expect(html).toContain('Failures');
    expect(html).toContain('Pass Rate');
  });

  it('6. generateHtmlReport: 通过率计算正确', () => {
    const html = generateHtmlReport(baseData);

    // 8/10 = 80%
    expect(html).toContain('80%');
  });

  it('7. generateHtmlReport: 零总数时通过率为 0%', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
      sections: [],
    };
    const html = generateHtmlReport(data);

    expect(html).toContain('0%');
  });

  // ─── 段落与项目 ──────────────────────────────────────

  it('8. generateHtmlReport: 段落标题和项目消息可见', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('Security');
    expect(html).toContain('Hardcoded API key');
    expect(html).toContain('No SQL injection');
  });

  it('9. generateHtmlReport: 包含文件位置信息', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('src/config.ts:5');
    expect(html).toContain('src/db.ts:12');
  });

  it('10. generateHtmlReport: 包含严重等级标签', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('high');
    expect(html).toContain('severity-high');
  });

  // ─── 空段落处理 ──────────────────────────────────────

  it('11. generateHtmlReport: 空段落显示 No issues found', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
      sections: [{ title: 'Empty Section', items: [] }],
    };
    const html = generateHtmlReport(data);

    expect(html).toContain('Empty Section');
    expect(html).toContain('No issues found');
  });

  // ─── 空报告 ──────────────────────────────────────────

  it('12. generateHtmlReport: 空报告正常渲染', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
      sections: [],
    };
    const html = generateHtmlReport(data);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('0%');
    expect(html).toContain('0'); // total checks
  });

  // ─── 选项 ────────────────────────────────────────────

  it('13. generateHtmlReport: 自定义标题', () => {
    const options: HtmlReportOptions = { title: 'Custom Report' };
    const html = generateHtmlReport(baseData, options);

    expect(html).toContain('Custom Report');
    expect(html).not.toContain('CodeShield Report');
  });

  it('14. generateHtmlReport: 自定义 lang 属性', () => {
    const options: HtmlReportOptions = { lang: 'zh-CN' };
    const html = generateHtmlReport(baseData, options);

    expect(html).toContain('<html lang="zh-CN">');
  });

  it('15. generateHtmlReport: includeStyles=false 不包含样式', () => {
    const options: HtmlReportOptions = { includeStyles: false };
    const html = generateHtmlReport(baseData, options);

    expect(html).not.toContain('<style>');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('16. generateHtmlReport: 默认包含样式', () => {
    const html = generateHtmlReport(baseData);

    expect(html).toContain('<style>');
  });

  // ─── XSS 防护 ────────────────────────────────────────

  it('17. generateHtmlReport: 转义 HTML 特殊字符', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      projectName: '<script>alert("xss")</script>',
      summary: { total: 1, passed: 1, warnings: 0, failures: 0 },
      sections: [
        {
          title: '<b>Bold</b> & "Quotes"',
          items: [{ status: 'pass', message: "It's a <test>" }],
        },
      ],
    };
    const html = generateHtmlReport(data);

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&#039;');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&lt;test&gt;');
  });

  // ─── 无项目名称 ──────────────────────────────────────

  it('18. generateHtmlReport: 无项目名称时不显示 Project 行', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      summary: { total: 1, passed: 1, warnings: 0, failures: 0 },
      sections: [],
    };
    const html = generateHtmlReport(data);

    expect(html).not.toContain('Project:');
  });

  // ─── 无文件的项目 ─────────────────────────────────────

  it('19. generateHtmlReport: 无文件位置时不渲染位置信息', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      summary: { total: 1, passed: 1, warnings: 0, failures: 0 },
      sections: [
        {
          title: 'General',
          items: [{ status: 'pass', message: 'All good' }],
        },
      ],
    };
    const html = generateHtmlReport(data);

    expect(html).toContain('All good');
    expect(html).not.toContain('<span class="item-location">');
  });

  // ─── 严重等级映射 ─────────────────────────────────────

  it('20. generateHtmlReport: 多种严重等级各有对应 CSS 类', () => {
    const data: HtmlReportData = {
      timestamp: '2026-01-01T00:00:00Z',
      summary: { total: 3, passed: 3, warnings: 0, failures: 0 },
      sections: [
        {
          title: 'Multi Severity',
          items: [
            { status: 'fail', message: 'Critical issue', severity: 'critical' },
            { status: 'warn', message: 'Medium issue', severity: 'medium' },
            { status: 'pass', message: 'Low info', severity: 'low' },
          ],
        },
      ],
    };
    const html = generateHtmlReport(data);

    expect(html).toContain('severity-critical');
    expect(html).toContain('severity-medium');
    expect(html).toContain('severity-low');
  });
});

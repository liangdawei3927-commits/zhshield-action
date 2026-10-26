/**
 * P2-7 回归：分数环下钻（score-ring-drilldown.test.tsx）
 *
 * 缺陷：点体检 76 分环页面无变化，用户看不到问题列表——分数是一个"死"数字。
 *
 * 修复：PageShell 的插图槽（分数环）在 DetailEntryContext 判定详情可用时
 * 变成可点按钮（与右上角「查看详情」图标同一判定源、同一动作），全域空态自动生效。
 * 无 Provider / available=false（详情分支、无数据的域）保持原样不可点。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { PageShell } from '../components/business/PageShell';
import { DetailEntryProvider } from '../contexts/DetailEntryContext';

function renderShell(available: boolean, withProvider: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      {withProvider ? (
        <DetailEntryProvider available={available} onOpen={() => undefined}>
          <Shell />
        </DetailEntryProvider>
      ) : (
        <Shell />
      )}
    </I18nProvider>,
  );
}

function Shell() {
  return (
    <PageShell
      illustration={<svg id="ring" viewBox="0 0 10 10" />}
      title="体检"
      subtitle="sub"
      buttonText="scan"
      onAction={() => undefined}
      actionDomain="inspect"
      loading={false}
    />
  );
}

describe('PageShell 分数环下钻（P2-7）', () => {
  it('真阳性：详情可用 → 分数环渲染为可点按钮，带查看详情语义', () => {
    const html = renderShell(true, true);
    expect(html).toContain('data-testid="score-ring-detail-entry"');
    expect(html).toContain('<button');
    expect(html).toContain('id="ring"'); // 环本身还在按钮里
  });

  it('误报防护：详情不可用（available=false）→ 环保持静态，不可点', () => {
    const html = renderShell(false, true);
    expect(html).not.toContain('score-ring-detail-entry');
    expect(html).toContain('id="ring"');
  });

  it('误报防护：无 Provider（详情分支/独立渲染）→ 环不可点', () => {
    const html = renderShell(true, false);
    expect(html).not.toContain('score-ring-detail-entry');
  });

  it('结构守卫：判定源必须来自 DetailEntryContext（不许另写一套判断）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../components/business/PageShell.tsx'),
      'utf-8',
    );
    expect(src).toContain('useDetailEntry()');
    expect(src).toContain('score-ring-detail-entry');
  });
});

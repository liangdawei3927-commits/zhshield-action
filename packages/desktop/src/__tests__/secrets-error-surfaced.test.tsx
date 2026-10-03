import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { SecretsListCard } from '../pages/secrets-parts';
import { I18nProvider } from '../i18n';

/**
 * 密钥扫描失败必须在界面上显式报错（2026-10-02 修复）。
 *
 * engine 不可用时 runSecrets 返回 `{ findings: [], error: '...' }`——注意
 * findings 是空数组而非 null。此前 SecurityPage 只把 findings 传给
 * SecretsListCard，error 从未被任何组件渲染：失败时用户看到的是
 * 「🟢 未发现密钥」的绿色空态，会把扫描失败误判为扫描通过。
 * SecretsHeader 里虽有 error 横幅，但该组件从未被任何页面渲染。
 */
function renderCard(error?: string | null): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <SecretsListCard
        findings={[]}
        error={error}
        onMarkRotating={() => {}}
        onVerifyRotated={() => {}}
        onDismiss={() => {}}
        onCopyToAi={() => {}}
        onCopyAll={() => {}}
      />
    </I18nProvider>,
  );
}

describe('SecretsListCard 扫描失败显式报错', () => {
  it('error 存在时渲染错误横幅与错误文案', () => {
    const markup = renderCard('engine unavailable');
    expect(markup).toContain('danger-50');
    expect(markup).toContain('engine unavailable');
  });

  it('error 存在时空态仍在，但错误横幅必须先于它出现', () => {
    // 有意保留空态：findings 为空是「无发现」的事实陈述，错误横幅负责说明
    // 「本次结果不可信」。彻底隐藏空态会连带丢失扫描成功但无命中的正常展示。
    const markup = renderCard('engine unavailable');
    expect(markup).toContain('🟢');
    expect(markup.indexOf('danger-50')).toBeLessThan(markup.indexOf('🟢'));
  });

  it('error 为空字符串时按无错误处理，不渲染横幅', () => {
    expect(renderCard('')).not.toContain('danger-50');
  });

  it('error 为 null / undefined 时保持原有绿色空态', () => {
    expect(renderCard(null)).not.toContain('danger-50');
    expect(renderCard(undefined)).not.toContain('danger-50');
    expect(renderCard(undefined)).toContain('🟢');
  });

  it('未传 error 时不渲染任何 danger 样式（无回归）', () => {
    expect(renderCard(undefined)).not.toContain('danger-50');
  });
});

/**
 * 接线层断言：SecretsListCard 已支持 error，但若 SecurityPage 不把
 * secretsReport.error 传下去，横幅依然永不显示——而组件级测试对此完全无感
 * （曾验证：删掉该 prop 后组件测试仍 5/5 全绿）。
 *
 * SecurityPage 默认停在 vuln 页签，切到 secrets 需要交互，renderToStaticMarkup
 * 无法驱动，故此处直接对源码断言接线，锁住这一环。
 */
describe('SecurityPage 必须把扫描错误接到列表卡', () => {
  const src = readFileSync(resolve(__dirname, '../pages/SecurityPage.tsx'), 'utf-8');

  it('渲染 SecretsListCard 时传入 error={secretsReport.error}', () => {
    expect(src).toContain('error={secretsReport.error}');
  });

  it('不再只渲染 SecretsHeader（其 error 横幅从未被任何页面使用）', () => {
    expect(src).not.toMatch(/<SecretsHeader\b/);
  });
});
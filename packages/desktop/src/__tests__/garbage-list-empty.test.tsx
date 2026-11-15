/**
 * 垃圾清单空态文案：「查过且干净」与「根本没查」必须分开说。
 *
 * 实测（2026-11-15，文档仓库）：三项检测只有文件系统检测器跑了，清单为空，
 * 页面正中写着「项目很干净，没有可清理的垃圾」，而同屏的黄色横幅刚说完
 * 「2 项检测未执行」——同一屏里一句话反驳另一句。空态必须带上未执行计数。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { GarbageList } from '../pages/garbage-list-parts';

beforeAll(() => {
  // node 环境无 localStorage，I18nProvider 退回 navigator.language；固定成中文
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

function renderEmpty(undetectedCount?: number): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <GarbageList
        items={[]}
        selected={new Set()}
        onToggle={() => undefined}
        undetectedCount={undetectedCount}
      />
    </I18nProvider>,
  );
}

describe('GarbageList 空清单文案', () => {
  it('有检测未执行 → 不宣称「项目很干净」，写明另有 N 项未检测', () => {
    const html = renderEmpty(2);
    expect(html).toContain('另有 2 项检测未执行');
    expect(html).not.toContain('项目很干净');
  });

  it('检测全部执行且无条目 → 才说项目很干净', () => {
    const html = renderEmpty(0);
    expect(html).toContain('项目很干净');
    expect(html).not.toContain('未执行');
  });

  it('未传 undetectedCount（旧调用点）→ 退回旧文案，不误报未检测', () => {
    expect(renderEmpty(undefined)).toContain('项目很干净');
  });
});

/**
 * 子项目提示的行为断言（只提示、不改判）。
 *
 * 2026-11-09 事故：扫描根被静默换成内层仓库，页面回落到旧报告显示「100 分优秀」，
 * 用户以为扫的是自己选的项目。因此这层提示必须满足两点：
 *   1. 未确认前只说「检测到子项目 X，是否改扫」，不得声称已经扫了它；
 *   2. 用户确认切换后，页面必须明确标注「本次扫描对象：X（子项目）」，
 *      不能让顶部的项目名继续冒充扫描对象。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { NestedProjectNotice } from '../pages/garbage-parts';

beforeAll(() => {
  // node 环境无 localStorage，I18nProvider 退回 navigator.language；固定成中文
  vi.stubGlobal('navigator', { language: 'zh-Hans-CN' });
});

const SUGGESTION = { path: '/outer/inner', name: 'inner' };

function render(active: boolean): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <NestedProjectNotice
        suggestion={SUGGESTION}
        active={active}
        scanning={false}
        onSwitch={() => undefined}
      />
    </I18nProvider>,
  );
}

describe('NestedProjectNotice', () => {
  it('未切换：说明检测到子项目并给出改扫入口，不声称已扫它', () => {
    const html = render(false);
    expect(html).toContain('检测到子项目 inner');
    expect(html).toContain('改扫该子项目');
    expect(html).not.toContain('本次扫描对象');
  });

  it('已切换：明确标注本次扫描对象，并给出改回入口', () => {
    const html = render(true);
    expect(html).toContain('本次扫描对象：inner');
    expect(html).toContain('改回当前项目');
    expect(html).not.toContain('是否改扫它');
  });
});

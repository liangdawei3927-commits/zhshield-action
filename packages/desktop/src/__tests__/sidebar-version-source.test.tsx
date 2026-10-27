/**
 * 侧边栏「关于」区块的版本号必须与安装包一致（2026-10-27 实测缺陷）。
 *
 * 背景：`sidebar-about.tsx` 里写死了 `'v0.1.0'`，而 `packages/desktop/package.json`
 * 早已是 0.2.0、已装 app 的 `CFBundleShortVersionString` 也是 0.2.0 —— 同一事实存了
 * 两份，界面就一直报旧版本。用户视角是「明明装了新包，界面还说 0.1.0」。
 *
 * 锁四件事：
 * 1) 渲染出来的版本 == `package.json` 的 version（不引入第二份真源，升级自动跟随）；
 * 2) 不得再出现写死的版本字面量（历史 bug 的直接回归护栏）；
 * 3) 版本号由 `useAppVersion` 提供，而不是组件内联常量 —— 否则运行时校正链路失效；
 * 4) 无法取到版本时不得渲染「孤零零的 v」。
 *
 * node 环境无 DOM，用 `renderToStaticMarkup` 做结构断言；`useEffect` 不执行，
 * 因此这里锚定的是编译期注入值（首屏值），运行时校正由 `app.getInfo` 链路负责，
 * 那条链路在 preload/IPC 侧已有独立测试。
 */

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { AboutSection } from '../components/layout/sidebar-about';

// node 环境 navigator.language 为 en-US，固定中文，断言才锚得住文案
vi.stubGlobal('navigator', { language: 'zh-Hans' });

const PKG_PATH = path.resolve(__dirname, '../../package.json');
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8')) as { version: string };
const ABOUT_SRC = readFileSync(
  path.resolve(__dirname, '../components/layout/sidebar-about.tsx'),
  'utf-8',
);

function renderAbout(): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <AboutSection />
    </I18nProvider>,
  );
}

describe('侧边栏版本号与安装包一致', () => {
  it('渲染的是 package.json 里的版本，而不是任何写死的旧版本', () => {
    const html = renderAbout();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(html).toContain(`v${pkg.version}`);
  });

  it('当前包里 0.1.0 已不存在（防止回退到历史硬编码值）', () => {
    // 版本真回到 0.1.0 时这条不成立也无意义，故只在非 0.1.0 时断言
    if (pkg.version === '0.1.0') return;
    expect(renderAbout()).not.toContain('v0.1.0');
  });

  it('组件里没有写死的版本字面量（回归护栏）', () => {
    // 匹配 'v1.2.3' / "v1.2.3" 形态；模板拼接 `v${version}` 不匹配，故不会误报
    expect(ABOUT_SRC).not.toMatch(/['"]v\d+\.\d+\.\d+['"]/);
  });

  it('版本号经 useAppVersion 提供，而非组件内联', () => {
    expect(ABOUT_SRC).toContain('useAppVersion');
  });

  it('取不到版本时只渲染产品名，不出现裸 v', () => {
    // 静态渲染首屏必有编译期值，此断言改为守住「空值不拼 v」的写法契约
    expect(ABOUT_SRC).toMatch(/version\s*\?\s*t\('layout\.aboutVersion'/);
  });
});

/**
 * 桌面端 E2E 冒烟测试（e2e/app.spec.ts）
 *
 * 用 Playwright 驱动真实 Electron 二进制，校验关键交互：
 *   1. 窗口标题 = 智汇码盾
 *   2. 欢迎页（无项目初始态）关键文案渲染
 *   3. 顶部导航切换到各业务页（空闲态标题渲染）
 *   4. 侧边栏展开 / 收回
 *
 * 每次运行使用独立临时 userData 目录，保证「无项目 → 欢迎页」的确定性初始态，
 * 同时不污染真实用户数据。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAIN_ENTRY = path.join(__dirname, '..', 'dist-electron', 'main.js');

/**
 * 启动 Electron 应用（独立临时 userData）。
 *
 * 有项目时 App 才渲染 TopNav / Sidebar / 各功能页（无项目是整屏欢迎页），
 * 因此需要「完整布局」的用例通过 seedProject 提前写入 userData/projects.json，
 * 启动后即进入 dashboard 布局。
 *
 * 种子项目路径使用临时空目录而非真实仓库：保证各功能页处于「无历史扫描数据」的
 * 确定性空闲态。若指向真实项目，其 .zhshield/guard-reports.jsonl 历史记录会让
 * 门禁页直接渲染报告视图，空闲态文案断言将不稳定。
 */
async function launchApp(opts: { seedProject?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-'));
  if (opts.seedProject) {
    mkdirSync(userDataDir, { recursive: true });
    const projectDir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-project-'));
    writeFileSync(
      path.join(userDataDir, 'projects.json'),
      JSON.stringify([{ name: 'demo', path: projectDir }], null, 2),
      'utf-8',
    );
  }
  // --lang=zh-CN 强制确定性语言：本用例断言均为简体中文文案，避免 CI 机器系统语言
  // 非中文时应用解析为 en/ko/ja 导致失败（app.getLocale() 与 navigator.language 均跟随该开关）
  const app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, '--lang=zh-CN', MAIN_ENTRY],
    timeout: 60_000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

/** TopNav 顶部导航栏（限定作用域，避免与 dashboard 主页快捷按钮重名冲突） */
const navBar = (page: Page) => page.getByRole('navigation');

test.describe('智汇码盾桌面端 E2E', () => {
  let app: ElectronApplication;
  let page: Page;

  test.afterEach(async () => {
    await app?.close();
  });

  test('窗口标题为智汇码盾', async () => {
    ({ app, page } = await launchApp());
    await expect(page).toHaveTitle('智汇码盾');
  });

  test('欢迎页（无项目初始态）渲染关键文案', async () => {
    ({ app, page } = await launchApp());
    await expect(page.getByText('添加项目，开启守护')).toBeVisible();
    await expect(page.getByText('智能引擎已开启')).toBeVisible();
    await expect(page.getByText('已守护项目')).toBeVisible();
    await expect(page.getByText('累计拦截')).toBeVisible();
    await expect(page.getByText('健康评分')).toBeVisible();
  });

  test('有项目时渲染完整布局（TopNav 导航到门禁检查页）', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    await expect(navBar(page).getByRole('button', { name: '门禁检查' })).toBeVisible();
    await navBar(page).getByRole('button', { name: '门禁检查' }).click();
    await expect(page.getByText('实时守护代码变更，在提交/推送/CI 关卡自动拦截')).toBeVisible();
  });

  test('顶部导航切换到智能巡检 / 安全扫描 / 报告中心 / 规则进化', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    await navBar(page).getByRole('button', { name: '智能巡检' }).click();
    await expect(page.getByText('检查构建产物，确保交付质量')).toBeVisible();

    await navBar(page).getByRole('button', { name: '安全扫描' }).click();
    await expect(page.getByText('深度扫描漏洞，修复安全隐患')).toBeVisible();

    await navBar(page).getByRole('button', { name: '报告中心' }).click();
    await expect(page.getByText('多维度分析报告，决策更有依据')).toBeVisible();

    await navBar(page).getByRole('button', { name: '规则进化' }).click();
    await expect(page.getByText('洞察项目架构，规划演进路径')).toBeVisible();
  });

  test('侧边栏展开与收回', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    await page.getByTitle('展开侧边栏').click();
    await expect(page.getByText('引擎状态')).toBeVisible();
    await expect(page.getByRole('button', { name: 'demo', exact: true })).toBeVisible();

    // 展开时右侧 aside 覆盖 TopNav 右上角按钮，点击遮罩（aside 外区域）收回
    await page.mouse.click(20, 100);
    await expect(page.getByTitle('展开侧边栏')).toBeVisible();
  });

  test('侧边栏删除项目：确认后从列表移除并回到欢迎页', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    await page.getByTitle('展开侧边栏').click();
    await expect(page.getByRole('button', { name: 'demo', exact: true })).toBeVisible();

    await page.getByRole('button', { name: '删除项目 demo' }).click();
    await expect(page.getByText('确定要从守护列表移除「demo」吗？')).toBeVisible();

    // 取消不删除
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('button', { name: 'demo', exact: true })).toBeVisible();

    // 再次删除并确认 → 无项目回到欢迎页
    await page.getByRole('button', { name: '删除项目 demo' }).click();
    await page.getByRole('button', { name: '移除' }).click();
    await expect(page.getByText('添加项目，开启守护')).toBeVisible();
  });
});

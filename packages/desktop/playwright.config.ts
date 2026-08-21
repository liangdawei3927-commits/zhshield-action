/**
 * 桌面端 E2E 配置（playwright.config.ts）
 *
 * 用 Playwright 驱动真实 Electron 二进制，校验窗口标题、欢迎页、
 * 顶部导航页面切换、侧边栏展开/收回等关键交互。
 *
 * 运行：pnpm --filter @zh/desktop test:e2e（脚本会先执行 build 保证 dist 最新）
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});

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
  // 只认 .ts：e2e 目录曾残留 tsc 编译出的 app.spec.js（.gitignore 忽略但仍在盘上），
  // Playwright 会把 .js 和 .ts 当成同一用例的两个副本一起跑 —— 旧副本跑旧断言，
  // 于是"改了测试却还在报旧文案"，且失败数翻倍。宁可只匹配源码。
  testMatch: '**/*.spec.ts',
  /**
   * 排除两类「人工取证」用例，它们不该给 CI 记红：
   *
   * - `*.verify.spec.ts`（自述「临时验证」）：断言绑的是当时那版实现的内部细节，
   *   例如空态健康环用 `locator('svg text')` 找刻度文案 —— 环的实现一改版就失配，
   *   但它验证的东西（空态有没有环）本身并没有回归。这类脚本的价值是"当时证过"，
   *   不是长期门禁。
   * - `nav-probe.spec.ts`（自述「穿透取证」）：以 `ZH_NAV_FIXTURE`（默认整个 monorepo 根）
   *   跑 `runFullCheck` 全量体检，单次 5 分钟以上量级，且依赖外部夹具，
   *   在 CI 里既慢又不可靠。
   *
   * 需要时手动跑：`pnpm --filter @zh/desktop test:e2e:verify`。
   */
  testIgnore: ['**/*.verify.spec.ts', '**/nav-probe.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});

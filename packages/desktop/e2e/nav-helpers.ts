/**
 * 导航 11 功能验证 · 共享工具与入口定义（非测试文件，供两个 spec 复用）
 */
import { _electron as electron, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const MAIN_ENTRY = path.join(__dirname, '..', 'dist-electron', 'main.js');

export const ELECTRON_BIN = (() => {
  try {
    return createRequire(path.join(__dirname, '..', 'package.json'))('electron') as string;
  } catch {
    return path.join(
      __dirname,
      '..',
      'node_modules',
      'electron',
      'dist',
      process.platform === 'darwin'
        ? 'Electron.app/Contents/MacOS/Electron'
        : 'electron',
    );
  }
})();

export const FIXTURE = process.env.ZH_NAV_FIXTURE ?? '/tmp/zh-nav-fixture';
export const SHOT_DIR = process.env.ZH_NAV_SHOTS ?? '/tmp/zh-nav-shots';

/** 顶部入口（TopNav 10 项 + 各页右上角报告中心），来源区分按钮所在容器。
 *  ⛔ 规则进化 / AI 工具已暂下线（见 src/feature-flags.ts），其侧边栏入口不在此表。 */
export interface NavEntry {
  id: string;
  label: string;
  where: 'nav' | 'banner' | 'sidebar' | 'shell';
  /** 页面标识文案候选（命中任一即判为渲染成功） */
  markers: string[];
  action: string;
}

/**
 * 与 `src/components/layout/nav-items.ts` 的 10 项 + 页面右上角入口 1 项（报告中心）
 * 严格一一对应。报告中心已移出导航栏，入口收敛到各页 PageShell 右上角按钮（where: 'shell'）。
 * ⛔ 规则进化（原侧边栏入口）与 AI 工具已暂下线：见 `src/feature-flags.ts`，
 * 恢复入口时必须同步本表。
 *
 * ⚠️ `entryButton()` 用 **label 当按钮选择器**（`getByRole('button', { name: e.label })`），
 * 所以本表的 label 必须等于该按钮当时的可见文字：**导航改名、页面删除、空态改版都要同步本表**，
 * 否则断言必渲染失败（2026-09-19 修复：原表仍留着已删的 dashboard 页、inspect 仍叫「质量巡检」、
 * markers 仍是旧空态卡）
 * 同时 nav-actions.spec.ts 的 `ACTION_CANDIDATES` 按 id 取主动作，新增/删除项也要一起改。
 */
export const ENTRIES: NavEntry[] = [
  { id: 'inspect', label: '项目体检', where: 'nav', markers: ['架构规范', '类型安全', '一键体检'], action: '一键体检' },
  { id: 'guard', label: '门禁系统', where: 'nav', markers: ['实时守护代码变更', '门禁', '检查项'], action: '立即扫描' },
  { id: 'sentinel', label: '哨兵监控', where: 'nav', markers: ['无间断监控', '监控已启动', '事件时间线'], action: '启动监控' },
  { id: 'security', label: '安全中心', where: 'nav', markers: ['深度扫描漏洞', '安全评分', '漏洞扫描'], action: '一键扫描' },
  { id: 'deps', label: '依赖管家', where: 'nav', markers: ['管家盘点', '开始盘点', '依赖图谱'], action: '开始盘点' },
  { id: 'garbage', label: '垃圾清理', where: 'nav', markers: ['清理无用文件', '开始扫描', '可清理'], action: '开始扫描' },
  { id: 'performance', label: '性能优化', where: 'nav', markers: ['检测运行时性能反模式', '开始性能检测', '性能'], action: '开始性能检测' },
  { id: 'techdebt', label: '技术债务', where: 'nav', markers: ['量化技术债', '开始盘点', '债务'], action: '开始盘点' },
  { id: 'refactor', label: '代码重构', where: 'nav', markers: ['优化代码结构', '马上检查', '重构'], action: '马上检查' },
  { id: 'backup', label: '备份中心', where: 'nav', markers: ['保护重要配置', '一键备份', '备份记录'], action: '一键备份' },
  { id: 'reports', label: '报告中心', where: 'shell', markers: ['分析报告', '汇总生成报告', '多维度分析报告'], action: '汇总生成报告' },
];

const { ELECTRON_RUN_AS_NODE: _d1, NODE_OPTIONS: _d2, ...CLEAN_ENV } = process.env;

export async function launchApp(): Promise<{
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  fakeHome: string;
  errors: string[];
}> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'zh-nav-'));
  const fakeHome = path.join(userDataDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'projects.json'),
    JSON.stringify([{ name: 'zh-nav-fixture', path: FIXTURE }], null, 2),
    'utf-8',
  );
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    // --no-sandbox: 受沙箱限制的 CI/受限环境（macOS 沙箱拦截 chromium sandbox 初始化）必须关闭
    args: [`--user-data-dir=${userDataDir}`, '--lang=zh-CN', '--no-sandbox', MAIN_ENTRY],
    timeout: 60_000,
    env: { ...CLEAN_ENV, HOME: fakeHome, E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => window.localStorage.setItem('zhshield.language', 'zh-Hans'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text().slice(0, 400)}`);
  });
  return { app, page, userDataDir, fakeHome, errors };
}

export function entryButton(page: Page, e: NavEntry) {
  if (e.where === 'nav') {
    return page.getByRole('navigation').getByRole('button', { name: e.label });
  }
  if (e.where === 'sidebar') {
    // ⛔ 侧边栏入口当前全部暂下线（规则进化 / AI 工具，见 src/feature-flags.ts）。
    // 本分支保留给未来恢复侧边栏入口时使用，恢复时需同步该表。
    return page.getByRole('complementary').getByRole('button', { name: e.label });
  }
  if (e.where === 'shell') {
    // 报告中心入口在各页 PageShell 右上角（不再占导航栏），仍按 label 命中
    return page.getByRole('button', { name: e.label }).first();
  }
  return page.getByRole('banner').getByRole('button', { name: e.label });
}

export async function clickEntry(page: Page, e: NavEntry) {
  if (e.where === 'sidebar') {
    await page.getByTitle('展开侧边栏').click();
  }
  const btn = entryButton(page, e);
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click();
  return btn;
}

/** main 内容区文本（排除隐藏侧边栏/顶栏噪声） */
export async function mainText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('main');
    return (el?.innerText ?? document.body.innerText).replace(/\s+/g, ' ').trim();
  });
}

const BUSY = ['扫描中', '检测中', '盘点中', '巡检中', '备份中', '分析中', '正在', '候检', '中...', '加载中'];

/** 等待页面安静：无进行中文案且文本连续 quietMs 未变 */
export async function waitSettled(
  page: Page,
  maxMs = 240_000,
  quietMs = 5_000,
): Promise<{ settled: boolean; elapsed: number }> {
  const t0 = Date.now();
  let last = '';
  let lastChange = Date.now();
  while (Date.now() - t0 < maxMs) {
    const txt = await mainText(page).catch(() => '');
    const busy = BUSY.some((b) => txt.includes(b));
    if (txt !== last) {
      last = txt;
      lastChange = Date.now();
    }
    if (!busy && Date.now() - lastChange >= quietMs) return { settled: true, elapsed: Date.now() - t0 };
    await page.waitForTimeout(1500);
  }
  return { settled: false, elapsed: Date.now() - t0 };
}

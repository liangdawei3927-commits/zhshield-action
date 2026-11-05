/**
 * 自动修复「应用 → 撤销」闭环端到端验证（e2e/refactor-autofix-undo.spec.ts）
 *
 * 用 Playwright 驱动真实 Electron 二进制，验证报告 §5.5 的用户侧闭环：
 *   ① 应用：一键应用自动修复，源码被改写，且**写盘前**已在
 *      `<项目>/.zhshield/backups/refactor-autofix-<时间戳>/` 留下备份（含 manifest.json）；
 *   ② 撤销入口来自磁盘事实：页面上的「可撤销」条来自备份目录枚举，不是渲染层内存；
 *   ③ 撤销：文件逐字节回滚、备份被消费（目录删除、入口随即消失）。
 *
 * 为什么必须是 E2E 而不是单测：这条链路横跨 渲染层 → IPC → 引擎子进程 → @zh/refactor
 * 四个进程/模块边界，任何一处接错（例如主进程还在用同步 fs、或子进程入口漏注册）
 * 单测都还是绿的，只有真点按钮才会露馅。单测已覆盖领域逻辑本身
 * （packages/refactor/src/__tests__/auto-fix-backup.test.ts），这里只守"能点通"。
 *
 * 本机不可跑（AGENTS.md：宿主环境泄漏 ELECTRON_RUN_AS_NODE / NODE_OPTIONS），
 * 首跑验证依赖 CI 的 desktop-e2e job；spec 自身做了剥离环境变量 + HOME 重定向的防御。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAIN_ENTRY = path.join(__dirname, '..', 'dist-electron', 'main.js');

const ELECTRON_BIN = (() => {
  try {
    return createRequire(path.join(__dirname, '..', 'package.json'))('electron') as string;
  } catch {
    return path.join(
      __dirname,
      '..',
      'node_modules',
      'electron',
      'dist',
      process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron',
    );
  }
})();

const { ELECTRON_RUN_AS_NODE: _d1, NODE_OPTIONS: _d2, ...CLEAN_ENV } = process.env;

/** 原始源码（4 个 public 字段 ⇒ inappropriate-intimacy 命中且可自动修复） */
const ORIGINAL_SOURCE = [
  'export class Order {',
  '  public id: string = "";',
  '  public total: number = 0;',
  '  public currency: string = "";',
  '  public note: string = "";',
  '}',
  '',
].join('\n');

/** 造一个只含「可自动修复异味」的最小项目（不掺别的检测项，避免按钮计数漂移） */
function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-autofix-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'order.ts'), ORIGINAL_SOURCE, 'utf-8');
  return dir;
}

async function launchApp(projectPath: string): Promise<{
  app: ElectronApplication;
  page: Page;
  errors: string[];
}> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-autofix-ud-'));
  const fakeHome = path.join(userDataDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'projects.json'),
    JSON.stringify([{ name: 'autofix-fixture', path: projectPath }], null, 2),
    'utf-8',
  );
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
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
  return { app, page, errors };
}

/** 顶部导航：入口按钮在 <header>（role=banner）里，不是 <nav> */
const navBar = (page: Page) => page.getByRole('banner');

/**
 * 等一次重构扫描真正落定（任务中心视角）。
 *
 * 为什么不靠"等某段文案出现"：本页的规则是「满分留在主页、不满分才自动展开详情」，
 * 扫描成功的表现有两种（停主页 / 进详情），文案判据会漏掉其中一种。
 * 任务中心的状态是唯一确定的落定信号，且扫描失败时必须立刻失败而不是干等 240s。
 */
async function waitRefactorScanSettled(page: Page, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await page.evaluate(async () => {
      const api = (window as unknown as {
        electronAPI: { tasks: { list: () => Promise<Array<{ kind: string; status: string }>> } };
      }).electronAPI;
      const list = await api.tasks.list();
      return list.filter((t) => t.kind === 'refactor').map((t) => t.status);
    });
    if (states.includes('done')) return;
    const settled = states.find((s) => s !== 'queued' && s !== 'running');
    if (settled) throw new Error(`重构扫描未成功落定：${states.join(',')}`);
    await page.waitForTimeout(1000);
  }
  throw new Error(`等待重构扫描落定超时（${timeoutMs}ms）`);
}

/** 进入详情：不满分时页面会自动展开，满分则停在主页，需要点右上角「查看详情」 */
async function enterRefactorDetail(page: Page): Promise<void> {
  const header = page.getByText('重构分析完成').first();
  if (await header.isVisible().catch(() => false)) return;
  const entry = page.locator('[data-testid="page-detail-entry"]');
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await expect(header).toBeVisible({ timeout: 30_000 });
}

/** 备份根下的所有备份目录名（新→旧由领域层保证，这里只关心存在与否） */
function backupDirs(projectPath: string): string[] {
  const root = path.join(projectPath, '.zhshield', 'backups');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

test.describe('自动修复应用 / 撤销闭环 E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let project: string;
  let errors: string[];

  test.beforeEach(async () => {
    project = makeFixture();
    ({ app, page, errors } = await launchApp(project));
  });

  test.afterEach(async () => {
    await app?.close();
  });

  test('应用自动修复留下备份；撤销后源码逐字节回滚且入口消失', async () => {
    test.setTimeout(300_000);
    const sourceFile = path.join(project, 'src', 'order.ts');

    // 进入重构页
    await navBar(page).getByRole('button', { name: '代码重构' }).click();
    await expect(page.getByText('优化代码结构，消除技术债务')).toBeVisible({ timeout: 15_000 });

    // ① 扫描：真正落定后再进详情（本页满分留主页、不满分自动展开，两种都兜住）
    await page.getByRole('button', { name: '马上检查' }).click();
    await waitRefactorScanSettled(page);
    await enterRefactorDetail(page);

    const applyBtn = page.getByRole('button', { name: /一键应用可自动修复/ });
    await expect(applyBtn).toBeVisible({ timeout: 30_000 });
    await expect(applyBtn).toContainText('1');
    // 未应用前不该有撤销入口（入口来自磁盘备份，不是凭空渲染）
    await expect(page.getByRole('button', { name: '撤销本次修复' })).toHaveCount(0);

    // ② 应用（写盘动作，带二次确认）
    await applyBtn.click();
    await expect(page.getByText(/将先备份到 \.zhshield\/backups/)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: '确认应用' }).click();
    await expect(page.getByText(/已应用 \d+ 个文件的自动修复/)).toBeVisible({ timeout: 120_000 });

    // 源码确实被改写：public → private
    const fixedSource = readFileSync(sourceFile, 'utf-8');
    expect(fixedSource).toContain('private id');
    expect(fixedSource).not.toContain('public id');

    // 备份是磁盘事实：目录 + 清单都在，且清单里的原文件副本与原件逐字节一致
    const afterApply = backupDirs(project);
    expect(afterApply.length).toBe(1);
    const backupDir = path.join(project, '.zhshield', 'backups', afterApply[0]);
    expect(existsSync(path.join(backupDir, 'manifest.json'))).toBe(true);
    expect(readFileSync(path.join(backupDir, 'src', 'order.ts'), 'utf-8')).toBe(ORIGINAL_SOURCE);

    // ③ 撤销入口出现（来自上面那份备份的枚举）
    await expect(page.getByText(/已修复 1 个文件.*可撤销/)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '撤销本次修复' }).click();
    await expect(page.getByText(/已撤销：恢复 1 个文件/)).toBeVisible({ timeout: 120_000 });

    // 撤销的真实效果：文件回到原件、备份被消费、入口消失
    expect(readFileSync(sourceFile, 'utf-8')).toBe(ORIGINAL_SOURCE);
    expect(backupDirs(project)).toEqual([]);
    await expect(page.getByRole('button', { name: '撤销本次修复' })).toHaveCount(0, {
      timeout: 30_000,
    });

    expect(errors, `渲染进程错误: ${errors.join(' | ')}`).toEqual([]);
  });
});

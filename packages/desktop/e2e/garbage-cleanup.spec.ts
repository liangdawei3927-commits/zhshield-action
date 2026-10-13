/**
 * 垃圾清理功能端到端验证（e2e/garbage-cleanup.spec.ts）
 *
 * 用 Playwright 驱动真实 Electron 二进制，验证「垃圾清理」页全链路：
 *   ① 扫描：文件系统检测器发现构建产物目录 / 垃圾文件 / 空文件，且不误报源码与 node_modules；
 *   ② 清理：勾选后可一键清理，文件被移入 <project>/.zhshield/trash/<batchId>，原位置消失，源码不动；
 *   ③ 恢复：点「恢复」后文件回到原位置，回收站批次目录清空。
 *
 * 每次运行使用独立临时 userData + 独立 fixture 项目，保证 hermetic、不污染真实数据。
 */
import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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

/** 造一个带明确垃圾 / 非垃圾的 fixture 项目 */
function makeFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-garbage-'));
  // 根级构建产物目录（可清理）
  mkdirSync(path.join(dir, 'dist'), { recursive: true });
  writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'x'.repeat(8 * 1024));
  // 垃圾文件（可清理）
  writeFileSync(path.join(dir, 'debug.log'), 'x');
  writeFileSync(path.join(dir, '.DS_Store'), 'x');
  // 空文件（非常见入口名，可清理）
  writeFileSync(path.join(dir, 'placeholder.txt'), '');
  // 真实源码（绝不可动）
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const a = 1;');
  // 依赖目录（必须被忽略）
  mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'pkg', 'dep.log'), 'x');
  return dir;
}

async function launchApp(projectPath: string): Promise<{
  app: ElectronApplication;
  page: Page;
  errors: string[];
}> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-garbage-ud-'));
  const fakeHome = path.join(userDataDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  writeFileSync(
    path.join(userDataDir, 'projects.json'),
    JSON.stringify([{ name: 'garbage-fixture', path: projectPath }], null, 2),
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

const navBar = (page: Page) => page.getByRole('navigation');

/** 列出 trash 下所有批次目录 */
function trashBatches(projectPath: string): string[] {
  const trashRoot = path.join(projectPath, '.zhshield', 'trash');
  if (!existsSync(trashRoot)) return [];
  return readdirSync(trashRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

test.describe('垃圾清理功能 E2E', () => {
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

  test('扫描发现垃圾但不误报源码/依赖；清理移入回收站；恢复还原', async () => {
    test.setTimeout(300_000);

    // 进入垃圾清理页（空态）
    await navBar(page).getByRole('button', { name: '垃圾清理' }).click();
    await expect(page.getByText('清理无用文件，为项目减负')).toBeVisible({ timeout: 15_000 });

    // ① 扫描
    await page.getByRole('button', { name: '开始扫描' }).click();
    // 报告页出现（标题 = page.garbage.done）
    await expect(page.getByText('垃圾清理完成')).toBeVisible({ timeout: 240_000 });
    await expect(page.getByText('可释放空间')).toBeVisible();

    // 检测到：构建产物 dist、垃圾文件 debug.log / .DS_Store、空文件 placeholder.txt
    for (const p of ['dist', 'debug.log', '.DS_Store', 'placeholder.txt']) {
      await expect(page.getByText(p, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    }
    // 不误报：真实源码、被忽略的 node_modules 内文件都不应出现
    await expect(page.getByText('src/main.ts', { exact: true })).toHaveCount(0);
    await expect(page.getByText('dep.log', { exact: true })).toHaveCount(0);

    // 删除白名单契约：空文件被检测但不在白名单内（不可清理），可清理项仅 dist/debug.log/.DS_Store
    await page.getByText('全选', { exact: true }).click();
    await expect(page.getByText('已选 3 项')).toBeVisible();
    const cleanBtn = page.getByRole('button', { name: /一键清理 \(3\)/ });
    await expect(cleanBtn).toBeEnabled();
    await cleanBtn.click();
    await expect(page.getByText(/已清理 3 项/)).toBeVisible({ timeout: 60_000 });

    expect(existsSync(path.join(project, 'dist'))).toBe(false);
    expect(existsSync(path.join(project, 'debug.log'))).toBe(false);
    expect(existsSync(path.join(project, '.DS_Store'))).toBe(false);
    expect(existsSync(path.join(project, 'placeholder.txt'))).toBe(true);
    expect(existsSync(path.join(project, 'src', 'main.ts'))).toBe(true);

    const batches = trashBatches(project);
    expect(batches.length).toBe(1);
    const batchDir = path.join(project, '.zhshield', 'trash', batches[0]);
    expect(existsSync(path.join(batchDir, 'dist'))).toBe(true);
    expect(existsSync(path.join(batchDir, 'debug.log'))).toBe(true);
    expect(existsSync(path.join(batchDir, 'placeholder.txt'))).toBe(false);

    // ③ 恢复
    await page.getByRole('button', { name: '恢复' }).click();
    await expect(page.getByText(/已恢复 3 项/)).toBeVisible({ timeout: 60_000 });

    // 恢复后文件回到原位，批次目录被清空
    expect(existsSync(path.join(project, 'dist', 'bundle.js'))).toBe(true);
    expect(existsSync(path.join(project, 'debug.log'))).toBe(true);
    expect(existsSync(path.join(project, '.DS_Store'))).toBe(true);
    expect(trashBatches(project).length).toBe(0);

    expect(errors, `渲染进程错误: ${errors.join(' | ')}`).toEqual([]);
  });
});

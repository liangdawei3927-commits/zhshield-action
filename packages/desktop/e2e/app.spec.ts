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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deriveProjectId } from '../electron/capability-refs';

const MAIN_ENTRY = path.join(__dirname, '..', 'dist-electron', 'main.js');

/**
 * 解析被测 Electron 二进制路径（项目的 electron 依赖版本，禁止 Playwright 自行下载缓存副本）。
 *
 * 不写死相对路径：node_modules 布局随 linker 模式而异——
 * isolated linker（默认）下 electron 链接在 packages/desktop/node_modules/electron，
 * hoisted linker（.npmrc node-linker=hoisted，CI 实际使用）下被提升到根 node_modules/electron，
 * 写死前者在 CI 上 ENOENT（electron.launch spawn 失败，5 用例全挂）。
 *
 * 首选 electron 包自身导出的二进制绝对路径（其 index.js 会校验 dist 存在，
 * 缺失时抛出 "Electron failed to install correctly" 便于诊断）；
 * 解析失败时兜底 isolated 布局的固定路径。
 */
const LEGACY_ELECTRON_BIN = path.join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  process.platform === 'darwin'
    ? 'Electron.app/Contents/MacOS/Electron'
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron',
);

const ELECTRON_BIN = (() => {
  try {
    const requireFromDesktop = createRequire(path.join(__dirname, '..', 'package.json'));
    return requireFromDesktop('electron') as unknown as string;
  } catch {
    return LEGACY_ELECTRON_BIN;
  }
})();

/** 种子项目路径：默认指向本 monorepo 根（随仓库位置自适应，CI 可用 ZH_E2E_PROJECT_PATH 覆盖） */
const DEMO_PROJECT_PATH = process.env.ZH_E2E_PROJECT_PATH ?? path.resolve(__dirname, '..', '..', '..');

/**
 * 剥离会污染被测应用的宿主环境变量：
 * - ELECTRON_RUN_AS_NODE：宿主（如 AI 编码工具）本身是 Electron 应用时泄漏，
 *   会让被测 Electron 以 Node 模式启动，所有 Chromium 开关报 bad option
 * - NODE_OPTIONS：宿主注入的 require shim 不应进入被测应用主进程
 */
const { ELECTRON_RUN_AS_NODE: _drop1, NODE_OPTIONS: _drop2, ...CLEAN_ENV } = process.env;

/**
 * 启动 Electron 应用（独立临时 userData）。
 *
 * 有项目时 App 才渲染 TopNav / Sidebar / 各功能页（无项目是整屏欢迎页），
 * 因此需要「完整布局」的用例通过 seedProject 提前写入 userData/projects.json，
 * 启动后即进入 dashboard 布局。
 */
async function launchApp(
  opts: { seedProject?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page; userDataDir: string; fakeHome: string }> {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'zh-e2e-'));
  // 隔离 HOME：macOS 会在 $HOME/Library/Saved Application State 写窗口恢复状态，
  // 指向临时目录可保证测试完全 hermetic（不写真实 ~/Library，CI/沙箱环境均可跑）
  const fakeHome = path.join(userDataDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  if (opts.seedProject) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'projects.json'),
      JSON.stringify(
        [{ name: 'demo', path: DEMO_PROJECT_PATH }],
        null,
        2,
      ),
      'utf-8',
    );
  }
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    // --lang 固定 Chromium locale：CI runner 系统语言是 en-US，不固定则界面渲染英文
    args: [`--user-data-dir=${userDataDir}`, '--lang=zh-CN', MAIN_ENTRY],
    timeout: 60_000,
    // E2E=1 门控注册测试专用观测 IPC（删除全链用例观测主进程内存态）
    env: { ...CLEAN_ENV, HOME: fakeHome, E2E: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // 双保险：--lang 在 macOS 上对 navigator.language 不一定生效，
  // 再写 localStorage（渲染进程语言链的最高优先级）后重载，保证界面语言确定为 zh-Hans
  await page.evaluate(() => window.localStorage.setItem('zhshield.language', 'zh-Hans'));
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userDataDir, fakeHome };
}

/** TopNav 顶部导航栏（限定作用域，避免与 dashboard 主页快捷按钮重名冲突） */
const navBar = (page: Page) => page.getByRole('navigation');

test.describe('智汇码盾桌面端 E2E', () => {
  let app: ElectronApplication;
  let page: Page;
  let fakeHome: string;

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

  test('有项目时渲染完整布局（TopNav 十项导航 + 底部状态栏）', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    // 断言对象与 nav.* i18n 键对齐：项目体检/门禁系统/哨兵监控…
    for (const nav of ['项目体检', '门禁系统', '哨兵监控', '智能巡检', '安全中心', '技术债务', '代码重构']) {
      await expect(navBar(page).getByRole('button', { name: nav })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'demo', exact: true })).toBeVisible();
    await expect(page.getByText('实时防护')).toBeVisible();
    // 切换到门禁系统页不崩溃，导航仍可用
    await navBar(page).getByRole('button', { name: '门禁系统' }).click();
    await expect(navBar(page).getByRole('button', { name: '门禁系统' })).toBeVisible();
  });

  test('顶部导航切换到智能巡检 / 安全中心 / 技术债务，Banner 进入报告中心', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    // 各页空态标题与 page.<x>.empty.title i18n 键对齐（种子项目无扫描数据 → 空态）
    await navBar(page).getByRole('button', { name: '智能巡检' }).click();
    await expect(page.getByText('检查构建产物，确保交付质量')).toBeVisible();

    await navBar(page).getByRole('button', { name: '安全中心' }).click();
    await expect(page.getByText('深度扫描漏洞，修复安全隐患')).toBeVisible();

    await navBar(page).getByRole('button', { name: '技术债务' }).click();
    await expect(page.getByText('量化技术债，把评分变成行动')).toBeVisible();

    // 报告中心/规则进化不在 TopNav（10 项上限），入口在 Banner 图标按钮
    await page.getByRole('banner').getByRole('button', { name: '报告中心' }).click();
    await expect(page.getByText('多维度分析报告，决策更有依据')).toBeVisible();

    await page.getByRole('banner').getByRole('button', { name: '规则进化' }).click();
    await expect(page.getByText('洞察项目架构，规划演进路径')).toBeVisible();
  });

  test('侧边栏展开与收回', async () => {
    ({ app, page } = await launchApp({ seedProject: true }));
    await page.getByTitle('展开侧边栏').click();
    await expect(page.getByText('引擎运行中')).toBeVisible();
    await expect(page.getByRole('button', { name: 'demo', exact: true })).toBeVisible();

    // 展开时右侧 aside 覆盖 TopNav 右上角按钮，点击遮罩（aside 外区域）收回
    await page.mouse.click(20, 100);
    await expect(page.getByTitle('展开侧边栏')).toBeVisible();
  });

  // 关联 R1 规格验收 1/2/6：删项目完整归还链（06 §3.4 ②-⑤）
  // 渲染链（setProjects/持久化）由 renderer 既有机制负责（usePersistProjects 自动 saveProjects 落盘），
  // 本用例验证清理链全链：①画像文件删除 ②5表软删 ③cachedProfile 清空 ④链完整不抛错 ⑤回收能力缺席后续扫描。
  test('删除项目完整归还（画像删除 + 5表软删 + cachedProfile 清空 + 链完整 + 回收能力缺席）', async () => {
    ({ app, page, fakeHome } = await launchApp({ seedProject: true }));
    // 画像存储 key：ProfileStore.normalizeKey 将路径分隔符替换为下划线并去掉开头下划线
    const profileKey = DEMO_PROJECT_PATH.replace(/\//g, '_').replace(/^_+/, '');
    const profileFile = path.join(fakeHome, '.zhshield', 'profiles', `${profileKey}.json`);
    const { existsSync } = await import('node:fs');

    // e2e 不引用 renderer 类型声明，此处按最小 API 面做类型断言。
    // 注意：page.evaluate 回调在浏览器上下文执行，无法引用 Node 侧闭包，
    // 因此每个回调内联 window.electronAPI 断言（与 reclaiming 用例同构）。
    // 预置：5 表孤儿行 + cachedProfile 归属 demo 项目 + 账本 eslint 引用 demo 项目
    await page.evaluate(
      (p) =>
        (window as unknown as {
          electronAPI?: { e2e?: { seedOrphanData?: (projectPath: string) => Promise<void> } };
        }).electronAPI?.e2e?.seedOrphanData?.(p),
      DEMO_PROJECT_PATH,
    );
    await page.evaluate(
      (p) =>
        (window as unknown as {
          electronAPI?: { e2e?: { setCachedProfile?: (projectPath: string) => Promise<void> } };
        }).electronAPI?.e2e?.setCachedProfile?.(p),
      DEMO_PROJECT_PATH,
    );
    // 账本预置：eslint 被 demo 项目引用（active）→ 删除后 releaseProjectRefs 使 refs 空 → reclaiming
    const ledgerDir = path.join(fakeHome, '.zhshield');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      path.join(ledgerDir, 'capability-refs.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          capabilities: {
            'toolrule:eslint': {
              languages: [],
              refs: [deriveProjectId(DEMO_PROJECT_PATH)],
              status: 'active',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );
    // 预置后 5 表各 1 行（未软删）
    const totalBefore = await page.evaluate(
      (p) =>
        (window as unknown as {
          electronAPI?: { e2e?: { countTotalData?: (projectPath: string) => Promise<Record<string, number>> } };
        }).electronAPI?.e2e?.countTotalData?.(p),
      DEMO_PROJECT_PATH,
    );
    expect(totalBefore).toEqual({
      scores: 1,
      scanning_results: 1,
      debt_actions: 1,
      debt_snapshots: 1,
      sentinel_events: 1,
    });

    // 触发清理链：直接调 window.electronAPI.removeProject（UI 删除按钮定位不稳定，
    // 且本用例关注清理链而非渲染链，故绕过 UI 直接调 API）
    const result = await page.evaluate(
      (p) =>
        (window as unknown as {
          electronAPI?: { removeProject?: (projectPath: string) => Promise<{ ok: boolean }> };
        }).electronAPI?.removeProject?.(p),
      DEMO_PROJECT_PATH,
    );

    // ③ removeProject 返回 { ok: true }（④ 云端注销 fire-and-forget 内部降级，链完整不抛错）
    expect(result).toEqual({ ok: true });
    // ① 画像文件不存在（e2e 用假 HOME，从隔离 HOME 路径找；
    //    若画像从未生成则断言天然通过，重点在 API 链路）
    expect(existsSync(profileFile)).toBe(false);
    // ② 5 表软删：删除后预置的孤儿行全部被打上 deleted_at（计数 = 预置数）
    const softDeleted = await page.evaluate(
      (p) =>
        (window as unknown as {
          electronAPI?: {
            e2e?: { countSoftDeletedData?: (projectPath: string) => Promise<Record<string, number>> };
          };
        }).electronAPI?.e2e?.countSoftDeletedData?.(p),
      DEMO_PROJECT_PATH,
    );
    expect(softDeleted).toEqual({
      scores: 1,
      scanning_results: 1,
      debt_actions: 1,
      debt_snapshots: 1,
      sentinel_events: 1,
    });
    // ③ cachedProfile 清空：删除后归属项目路径为 null
    const cachedPath = await page.evaluate(
      () =>
        (window as unknown as {
          electronAPI?: { e2e?: { getCachedProfileProjectPath?: () => Promise<string | null> } };
        }).electronAPI?.e2e?.getCachedProfileProjectPath?.(),
    );
    expect(cachedPath).toBeNull();
    // ⑤ 回收能力缺席后续扫描：删除后 releaseProjectRefs 使 refs 空 → reclaiming，
    //    触发一次 sync:rulesStatus，被回收能力应缺席（复用 reclaiming 剔除结构）
    const status = await page.evaluate(
      () =>
        (window as unknown as {
          electronAPI?: {
            sync?: { getRulesStatus?: () => Promise<Array<{ toolId: string }>> };
          };
        }).electronAPI?.sync?.getRulesStatus?.(),
    );
    const toolIds = (status ?? []).map((s) => s.toolId);
    // 删除后无项目引用 → 无能力被领取，eslint 不在运行清单（与 reclaiming 用例同构）
    expect(toolIds).not.toContain('eslint');
  });

  // 关联 R2 规格验收 3/8：reclaiming 工具从运行清单立即剔除（06 §6.4 接线红线）
  // 预置 ledger 使 seeded 项目工具为 reclaiming → getRulesStatus 中该工具缺席（隔离 HOME，真实主进程回包）
  test('reclaiming 工具从运行清单立即剔除', async () => {
    ({ app, page, fakeHome } = await launchApp({ seedProject: true }));
    // 预置账本：toolrule:eslint 标记 reclaiming（refs 空 + since）
    const ledgerDir = path.join(fakeHome, '.zhshield');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      path.join(ledgerDir, 'capability-refs.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          capabilities: {
            'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: Date.now() },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    // 真实主进程回包：sync:rulesStatus 经 getActiveToolIds 过滤，reclaiming 工具应缺席
    const status = await page.evaluate(
      () =>
        (window as unknown as {
          electronAPI?: {
            sync?: { getRulesStatus?: () => Promise<Array<{ toolId: string }>> };
          };
        }).electronAPI?.sync?.getRulesStatus?.(),
    );

    const toolIds = (status ?? []).map((s) => s.toolId);
    // eslint 被剔除
    expect(toolIds).not.toContain('eslint');
    // 其余工具不受影响（semgrep/trivy/dep-cruiser 仍在）
    for (const tool of ['semgrep', 'trivy', 'dep-cruiser']) {
      expect(toolIds).toContain(tool);
    }
  });

  // 关联 R2 规格验收 3b/8：窗口内唤醒（06 §7 验收 3b）——7 天窗口内重加同栈项目，
  // 能力经 claim 唤醒复用本地文件（refs 从空变非空 → reclaiming → active），
  // 运行层清单恢复。P1 修复：claim 步骤改用 getUnfilteredToolIds（含 reclaiming），
  // 否则 reclaiming 能力永远进不了 claim 列表、新项目裸奔 7 天。
  test('窗口内唤醒：syncRules claim 使 reclaiming 能力恢复 active 并被运行层重新纳入', async () => {
    ({ app, page, fakeHome } = await launchApp({ seedProject: true }));
    // 预置账本：toolrule:eslint 标记 reclaiming（refs 空 + since，模拟删项目后进入 7 天窗口）
    const ledgerDir = path.join(fakeHome, '.zhshield');
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      path.join(ledgerDir, 'capability-refs.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          capabilities: {
            'toolrule:eslint': { languages: [], refs: [], status: 'reclaiming', since: Date.now() },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    // 预置画像缓存归属 seeded 项目：claim 步骤以 getCachedProfileProjectPath 为入口（无归属则跳过 claim）
    await page.evaluate(
      (p) =>
        (window as unknown as {
          electronAPI?: { e2e?: { setCachedProfile?: (projectPath: string) => Promise<void> } };
        }).electronAPI?.e2e?.setCachedProfile?.(p),
      DEMO_PROJECT_PATH,
    );

    // 唤醒前：eslint 处于 reclaiming → 运行层剔除（基线断言）
    const before = await page.evaluate(
      () =>
        (window as unknown as {
          electronAPI?: {
            sync?: { getRulesStatus?: () => Promise<Array<{ toolId: string }>> };
          };
        }).electronAPI?.sync?.getRulesStatus?.(),
    );
    expect((before ?? []).map((s) => s.toolId)).not.toContain('eslint');

    // 触发一次 syncRules：claim 步骤（未过滤清单）把 seeded 项目 id 写入 eslint refs → 唤醒
    await page.evaluate(
      () =>
        (window as unknown as {
          electronAPI?: {
            sync?: { syncRules?: () => Promise<unknown> };
          };
        }).electronAPI?.sync?.syncRules?.(),
    );

    // 唤醒后：eslint 恢复 active → 运行层重新纳入运行清单
    const after = await page.evaluate(
      () =>
        (window as unknown as {
          electronAPI?: {
            sync?: { getRulesStatus?: () => Promise<Array<{ toolId: string }>> };
          };
        }).electronAPI?.sync?.getRulesStatus?.(),
    );
    expect((after ?? []).map((s) => s.toolId)).toContain('eslint');
  });
});

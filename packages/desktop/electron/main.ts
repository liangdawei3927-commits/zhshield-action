// PATH 补全必须在所有 import 之前执行，确保后续模块和子进程继承完整路径
import { augmentProcessPath } from './env';
augmentProcessPath();

import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { t, initI18n, setLanguage, resolveLanguage } from '@zh/i18n';

import {
  setMainWindow,
  getMainWindow,
  VITE_DEV_SERVER_URL,
  API_BASE,
  sopCache,
  wisdomBrainSync,
  shutdownSentinel,
} from './ipc-context';
import { registerProjectsIpc } from './ipc/projects';
import { registerAiToolsIpc, syncAiIntegrationOnStartup } from './ipc/ai-tools';
import { registerSyncIpc } from './ipc/sync';
import { registerToolsIpc } from './ipc/tools';
import { startResolveReconcileTimer } from './ipc/resolve-reconcile';
import { startProfileDriftWatcher } from './profile-drift';
import { registerEnginesIpc } from './ipc/engines';
import { registerTasksIpc } from './ipc/tasks';
import { buildTaskManager } from './task-manager';
import { registerGuardHooksIpc } from './ipc/guard-hooks';
import { registerGuardConfigIpc } from './ipc/guard-config';
import { registerSentinelIpc } from './ipc/sentinel';
import { registerFeedbackIpc } from './ipc/feedback';
import { registerEvolveIpc } from './ipc/evolve';
import { registerBackupIpc } from './ipc/backup';
import { registerSchedulerIpc } from './ipc/scheduler';
import { preheatPipelineWorker, disposePipelineWorker } from './pipeline-host';
import { setupAutoUpdater } from './auto-updater';
import { enforceTrustedIpcSender } from './ipc-security';

// ─── 安全：IPC sender 来源校验（须在注册任何 handler 之前调用）────
enforceTrustedIpcSender();

// 仅在 GPU 崩溃时回退到软件渲染（默认使用系统 GPU 后端，macOS 为 Metal）
app.on('child-process-gone', (_event, details) => {
  if (details.type === 'GPU' && details.reason === 'crashed') {
    app.disableHardwareAcceleration();
    console.warn('[GPU] GPU process crashed, falling back to software rendering');
  }
});
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// GPU 进程日志写入文件，避免终端刷屏（已知 macOS EGL 兼容性日志）
app.commandLine.appendSwitch('enable-logging', 'file');

// 解决打包后路径问题
const MAIN_DIST = path.join(__dirname, '../dist');
const PRELOAD_PATH = path.join(__dirname, './preload.js');

/** 加载页面：开发模式走 dev server，否则加载打包产物 */
function loadMainPage(window: BrowserWindow): void {
  if (VITE_DEV_SERVER_URL) {
    window.loadURL(VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(path.join(MAIN_DIST, 'index.html'));
  }
}

/** 页面加载完成后显示（避免白屏闪烁），关闭时清空主窗口引用 */
function attachWindowVisibility(window: BrowserWindow): void {
  window.once('ready-to-show', () => {
    window.show();
  });
  window.on('closed', () => {
    setMainWindow(null);
  });
}

/** 窗口最大化 / 全屏状态变化通知渲染进程 */
function attachWindowStateEvents(window: BrowserWindow): void {
  window.on('maximize', () => {
    window.webContents.send('window:maximized', true);
  });
  window.on('unmaximize', () => {
    window.webContents.send('window:maximized', false);
  });
  window.on('enter-full-screen', () => {
    window.webContents.send('window:maximized', true);
  });
  window.on('leave-full-screen', () => {
    window.webContents.send('window:maximized', false);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: t('electron.appTitle'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    backgroundColor: '#FFFFFF',
    show: false,
  });
  setMainWindow(window);

  loadMainPage(window);
  attachWindowVisibility(window);
  attachWindowStateEvents(window);

  // ─── 安全：阻止渲染进程发起的导航（防止打开外部 URL）────
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
}

// IPC: 窗口控制
ipcMain.on('window:minimize', () => getMainWindow()?.minimize());
ipcMain.on('window:maximize', () => {
  const window = getMainWindow();
  if (window?.isMaximized()) {
    window.unmaximize();
  } else {
    window?.maximize();
  }
});
ipcMain.on('window:close', () => getMainWindow()?.close());

ipcMain.handle(
  'window:isMaximized',
  () => (getMainWindow()?.isMaximized() || getMainWindow()?.isFullScreen()) ?? false,
);

// 对话框：打开原生文件夹选择器
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle(
  'dialog:showSave',
  async (
    _event,
    options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> },
  ) => {
    const result = await dialog.showSaveDialog({
      defaultPath: options.defaultPath,
      filters: options.filters,
    });
    return { canceled: result.canceled, filePath: result.filePath };
  },
);

ipcMain.handle('dialog:writeFile', async (_event, filePath: string, content: string) => {
  const resolvedPath = path.resolve(filePath);
  const normalizedPath = path.normalize(resolvedPath);
  if (normalizedPath !== resolvedPath) {
    throw new Error('Invalid file path: path traversal detected');
  }

  const userData = path.normalize(app.getPath('userData'));
  const allowedRoots = [userData];
  try {
    const projectsFile = path.join(app.getPath('userData'), 'projects.json');
    const projects = JSON.parse(await fs.promises.readFile(projectsFile, 'utf-8')) as Array<{
      path: string;
    }>;
    for (const p of projects) {
      allowedRoots.push(path.normalize(p.path));
    }
  } catch {
    // projects.json unreadable — restrict to userData only
  }

  const isAllowed = allowedRoots.some(
    (root) => normalizedPath.startsWith(root + path.sep) || normalizedPath === root,
  );
  if (!isAllowed) {
    throw new Error('Write path must be within a project directory or application data directory');
  }

  await fs.promises.writeFile(resolvedPath, content, 'utf-8');
});

/** 打开外部链接或已注册 URL scheme（如 trae://）,返回是否成功唤起 */
ipcMain.handle('app:openExternal', async (_event, url: string) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return await shell.openExternal(url);
  } catch (err) {
    console.warn('[app:openExternal] 打开失败:', err instanceof Error ? err.message : err);
    return false;
  }
});

// 应用信息
ipcMain.handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  platform: process.platform,
  apiBase: API_BASE,
}));

// ─── 国际化：系统语言 + 渲染进程语言偏好同步 ────────────────
// 主进程语言偏好持久化到 <userData>/language.json（node:fs 读写，无新依赖）
const LANGUAGE_FILE = 'language.json';

function languageFilePath(): string {
  return path.join(app.getPath('userData'), LANGUAGE_FILE);
}

async function readSavedLanguage(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(languageFilePath(), 'utf-8')) as {
      language?: unknown;
    };
    return typeof parsed.language === 'string' && parsed.language !== '' ? parsed.language : null;
  } catch {
    return null;
  }
}

async function writeSavedLanguage(lng: string): Promise<void> {
  try {
    await fs.promises.mkdir(app.getPath('userData'), { recursive: true });
    await fs.promises.writeFile(
      languageFilePath(),
      `${JSON.stringify({ language: lng }, null, 2)}\n`,
      'utf-8',
    );
  } catch (err) {
    console.warn('[i18n] 语言偏好持久化失败:', err instanceof Error ? err.message : String(err));
  }
}

// 启动即初始化主进程 i18n：用户偏好优先，否则跟随系统语言（独立于渲染进程的实例）
// 延迟到 app.whenReady 内执行（readSavedLanguage 现为异步），IPC 处理器仅在窗口创建后触发，不受影响
let _currentLanguage: string | null = null;
ipcMain.handle('app:getLocale', () => app.getLocale());
ipcMain.on('i18n:set-language', (_event, lng: string) => {
  _currentLanguage = lng;
  // 持久化偏好并同步主进程翻译语言，使菜单/对话框/进度文案跟随渲染进程选择
  void writeSavedLanguage(lng).catch((err) => {
    console.warn('[i18n] 保存语言偏好失败:', err instanceof Error ? err.message : String(err));
  });
  void setLanguage(resolveLanguage(lng, null).value);
  getMainWindow()?.webContents.send('i18n:language-changed', lng);
});

/**
 * 外部扫描 CLI 可用性（桌面降级提示）。
 * PATH 补全已在进程启动早期通过 augmentProcessPath() 完成，
 * 覆盖 nvm、Homebrew、~/.local/bin 及 workspace node_modules/.bin，
 * 此处 execFile 探测可直接命中这些目录下的工具。
 */
ipcMain.handle(
  'tools:availability',
  async (): Promise<Array<{ id: string; available: boolean }>> => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const tools = ['eslint', 'semgrep', 'trivy', 'gitleaks', 'depcruise', 'jscpd'];
    // semgrep 启动需加载大量 Python 依赖（--version 实测约 13s），远超默认 3s 超时，需单独放宽
    const TOOL_TIMEOUT_MS: Record<string, number> = { semgrep: 30000 };
    const results: Array<{ id: string; available: boolean }> = [];
    for (const id of tools) {
      try {
        await execFileAsync(id, ['--version'], { timeout: TOOL_TIMEOUT_MS[id] ?? 3000 });
        results.push({ id, available: true });
      } catch {
        results.push({ id, available: false });
      }
    }
    return results;
  },
);

// ─── 各功能域 IPC 注册 ─────────────────────────────────────
registerProjectsIpc();
registerAiToolsIpc();
registerSyncIpc();
registerToolsIpc();
const taskManager = buildTaskManager();
registerTasksIpc(taskManager);
registerEnginesIpc(taskManager);
registerGuardHooksIpc();
registerGuardConfigIpc();
registerSentinelIpc();
registerFeedbackIpc();
registerEvolveIpc();
registerBackupIpc();
registerSchedulerIpc();

/** 初始化 SOP 缓存（网络同步不阻塞窗口创建，避免与体检并发抢 DNS/主线程） */
async function initSopCache() {
  // 缓存初始化（SQLite 等）失败不应阻断窗口创建 — 降级为内置规则只读模式（与 server 端 SopService 一致）
  let initialized = false;
  try {
    await sopCache.initialize();
    initialized = true;
  } catch (err) {
    console.warn(
      '[sop] 缓存初始化失败，降级为内置规则只读模式:',
      err instanceof Error ? err.message : err,
    );
  }
  if (!initialized) return;
  sopCache.startPeriodicSync();
  // T1 免维护同步：云端规则对账循环（与 SOP 定时同步同频）+ 画像漂移监听
  startResolveReconcileTimer();
  startProfileDriftWatcher();
  // 云端同步放到下一轮事件循环，失败不影响本地体检
  setImmediate(() => {
    void sopCache.checkOnStartup().catch((err) => {
      console.warn(
        '[sop] 启动同步失败（将使用本地规则）:',
        err instanceof Error ? err.message : err,
      );
    });
  });
}

/** 初始化智汇大脑协同 */
async function initWisdomBrainSync() {
  await wisdomBrainSync.initialize();
  wisdomBrainSync.getRuleSync().startPeriodicSync();
}

// ─── 应用就绪 ────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ─── 安全：CSP 响应头 ─────────────────────────────────────
  // 开发模式跳过 CSP：Vite 需要注入 inline script 实现 HMR 和 React Fast Refresh，
  // 严格的 script-src 'self' 会阻断这些脚本导致白屏。
  if (!VITE_DEV_SERVER_URL) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            // 生产模式 CSP：不放行 http://localhost:*，防止渲染进程被利用连接本机任意端口
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.zhishield.com; img-src 'self' data:; font-src 'self'",
          ],
        },
      });
    });
  }

  // ─── 安全：拒绝所有不必要的权限请求（camera / mic / geolocation 等）──
  // 仅放行 clipboard-sanitized-write（navigator.clipboard.writeText 必需，一刀切拒绝会让
  // 所有页面「复制到AI」报复制失败）与 notifications（桌面通知必需），勿删。
  const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
    'clipboard-sanitized-write',
    'notifications',
  ]);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  await initSopCache();
  // 智汇大脑同步不阻塞窗口；网络失败时静默降级
  void initWisdomBrainSync().catch((err) => {
    console.warn('[wisdom] 初始化失败:', err instanceof Error ? err.message : err);
  });
  // 主进程 i18n 初始化（readSavedLanguage 为异步，须在 whenReady 内 await）
  initI18n({ lng: resolveLanguage(await readSavedLanguage(), app.getLocale()).value });
  createWindow();
  const mainWindow = getMainWindow();
  if (mainWindow) setupAutoUpdater(mainWindow);
  // 后台预热体检子进程，避免首次点击冷启动过久
  preheatPipelineWorker();
  void syncAiIntegrationOnStartup();

  // macOS: 点击 dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  disposePipelineWorker();
  shutdownSentinel();
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

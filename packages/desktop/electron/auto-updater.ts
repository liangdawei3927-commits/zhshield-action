import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';
import { classifyUpdateError, describeError } from './update-error';

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function scheduleInitialCheck(): void {
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      // 主进程日志可保留完整明细（describeError），仅限本地排查用，不跨 IPC
      console.error('[auto-updater] 首次检查失败（非致命）:', describeError(err));
    });
  }, 30000);
}

function registerCheckHandler(): void {
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (err) {
      // 只向渲染端暴露错误码 + 通用文案，原始错误信息（路径/地址/细节）不得外泄
      const { code, message } = classifyUpdateError(err);
      console.error('[auto-updater] 检查更新失败:', describeError(err));
      return { available: false, code, message };
    }
  });
}

function registerDownloadHandler(): void {
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      const { code, message } = classifyUpdateError(err);
      console.error('[auto-updater] 下载更新失败:', describeError(err));
      return { success: false, code, message };
    }
  });
}

function registerInstallHandler(): void {
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });
}

function registerStatusListeners(mainWindow: BrowserWindow): void {
  autoUpdater.on('checking-for-update', () => {
    mainWindow.webContents.send('update:status', { state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    mainWindow.webContents.send('update:status', { state: 'available', version: info.version });
  });
  autoUpdater.on('update-not-available', () => {
    mainWindow.webContents.send('update:status', { state: 'not-available' });
  });
  autoUpdater.on('download-progress', (progress) => {
    mainWindow.webContents.send('update:status', {
      state: 'downloading',
      percent: progress.percent,
    });
  });
  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('update:status', { state: 'downloaded' });
  });
  autoUpdater.on('error', (err) => {
    // 与上保持一致：渲染端只拿错误码 + 通用文案
    const { code, message } = classifyUpdateError(err);
    console.error('[auto-updater] 更新过程错误:', describeError(err));
    mainWindow.webContents.send('update:status', { state: 'error', code, message });
  });
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  scheduleInitialCheck();
  registerCheckHandler();
  registerDownloadHandler();
  registerInstallHandler();
  registerStatusListeners(mainWindow);
}

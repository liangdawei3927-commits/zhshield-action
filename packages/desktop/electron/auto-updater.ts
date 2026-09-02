import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

function scheduleInitialCheck(): void {
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[auto-updater] 首次检查失败（非致命）:', String(err));
    });
  }, 30000);
}

function registerCheckHandler(): void {
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (err) {
      return { available: false, error: String(err) };
    }
  });
}

function registerDownloadHandler(): void {
  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
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
    mainWindow.webContents.send('update:status', { state: 'error', message: String(err) });
  });
}

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  scheduleInitialCheck();
  registerCheckHandler();
  registerDownloadHandler();
  registerInstallHandler();
  registerStatusListeners(mainWindow);
}

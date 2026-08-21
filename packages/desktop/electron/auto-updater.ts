import { autoUpdater } from 'electron-updater';
import { BrowserWindow, ipcMain } from 'electron';

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

export function setupAutoUpdater(mainWindow: BrowserWindow): void {
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 30000);

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { available: !!result?.updateInfo, version: result?.updateInfo?.version };
    } catch (err) {
      return { available: false, error: String(err) };
    }
  });

  ipcMain.handle('update:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
  });

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
    mainWindow.webContents.send('update:status', { state: 'downloading', percent: progress.percent });
  });
  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('update:status', { state: 'downloaded' });
  });
  autoUpdater.on('error', (err) => {
    mainWindow.webContents.send('update:status', { state: 'error', message: String(err) });
  });
}

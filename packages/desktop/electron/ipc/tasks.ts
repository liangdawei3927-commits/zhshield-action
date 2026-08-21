import { ipcMain } from 'electron';
import { t } from '@zh/i18n';
import type { TaskKind, TaskManager } from '../task-manager';

export function registerTasksIpc(manager: TaskManager): void {
  ipcMain.handle('tasks:start', (_event, kind: TaskKind, projectPath: string, options?: Record<string, unknown>) => {
    if (!kind || typeof kind !== 'string' || typeof projectPath !== 'string' || !projectPath) {
      throw new Error(t('electron.invalidParams'));
    }
    return manager.start(kind, projectPath, options);
  });

  ipcMain.handle('tasks:list', () => manager.list());

  ipcMain.handle('tasks:cancel', (_event, id: string) => {
    if (typeof id !== 'string' || !id) return false;
    return manager.cancel(id);
  });
}

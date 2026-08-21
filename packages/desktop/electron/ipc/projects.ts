/**
 * 项目持久化 IPC（ipc/projects.ts）
 *
 * 加载 / 保存项目列表（userData/projects.json）。
 */

import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

export const PROJECTS_FILE = path.join(app.getPath('userData'), 'projects.json');

export function registerProjectsIpc(): void {
  ipcMain.handle('app:loadProjects', async (): Promise<Array<{ name: string; path: string }>> => {
    try {
      if (fs.existsSync(PROJECTS_FILE)) {
        return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('Failed to load projects:', e);
    }
    return [];
  });

  ipcMain.handle('app:saveProjects', async (_event, projects: Array<{ name: string; path: string }>): Promise<void> => {
    try {
      fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save projects:', e);
    }
  });
}

/**
 * 项目持久化 IPC（ipc/projects.ts）
 *
 * 加载 / 保存项目列表（userData/projects.json）。
 */

import { app, ipcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PROJECTS_FILE = path.join(app.getPath('userData'), 'projects.json');

export function registerProjectsIpc(): void {
  ipcMain.handle('app:loadProjects', async (): Promise<Array<{ name: string; path: string }>> => {
    try {
      return JSON.parse(await readFile(PROJECTS_FILE, 'utf-8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to load projects:', e);
      }
    }
    return [];
  });

  ipcMain.handle(
    'app:saveProjects',
    async (_event, projects: Array<{ name: string; path: string }>): Promise<void> => {
      try {
        await writeFile(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8');
      } catch (e) {
        console.error('Failed to save projects:', e);
      }
      // 项目列表变化 → 画像漂移监听纳入新项目（动态导入避免与 profile-drift 循环依赖）
      void import('../profile-drift').then((m) => m.rewatchProjectsAfterChange());
    },
  );
}

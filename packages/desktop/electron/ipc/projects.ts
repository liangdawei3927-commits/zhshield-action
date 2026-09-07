/**
 * 项目持久化 IPC（ipc/projects.ts）
 *
 * 加载 / 保存项目列表（userData/projects.json）。
 * saveProjects 采用原子写入（临时文件 + rename），避免写盘中断产生半截 JSON；
 * removeProject 返回每步成败并写删除审计日志，失败可观测而不改变解耦语义。
 */

import { app, ipcMain } from 'electron';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AuditLogger } from '@zh/shared';
import { cleanupProjectAfterRemoval } from '../project-lifecycle';

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
      const tmpFile = `${PROJECTS_FILE}.tmp`;
      try {
        // 原子写入：先写临时文件，成功后 rename 覆盖，避免写盘中断产生半截 JSON
        await writeFile(tmpFile, JSON.stringify(projects, null, 2), 'utf-8');
        await rename(tmpFile, PROJECTS_FILE);
      } catch (e) {
        console.error('Failed to save projects:', e);
      } finally {
        // 清理残留临时文件；rename 失败不掩盖原错误
        await rm(tmpFile, { force: true }).catch(() => {});
      }
      // 项目列表变化 → 画像漂移监听纳入新项目（动态导入避免与 profile-drift 循环依赖）
      void import('../profile-drift').then((m) => m.rewatchProjectsAfterChange());
    },
  );

  ipcMain.handle(
    'app:removeProject',
    async (_event, projectPath: string): Promise<{ ok: boolean; errors?: string[] }> => {
      const steps = await cleanupProjectAfterRemoval(projectPath);
      const ok = steps.every((s) => s.status === 'ok');
      // 删除审计落盘（~/.zhshield/audit/project-removal/）；审计失败静默，不改变返回
      void new AuditLogger()
        .logProjectRemoval({ projectId: projectPath, ok, steps })
        .catch(() => {});
      return { ok, errors: steps.filter((s) => s.status === 'failed').map((s) => s.step) };
    },
  );
}

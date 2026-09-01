/**
 * 演进引擎 IPC（ipc/evolve.ts）
 *
 * 建议 / 经验 / 规则权重相关查询与记录。
 */

import { ipcMain } from 'electron';

import type { EvolveEngine } from '@zh/evolve';
import { getEvolve } from '../ipc-context';

export function registerEvolveIpc(): void {
  registerEvolveQueries();
  registerEvolveWrites();
}

function registerEvolveQueries(): void {
  ipcMain.handle('evolve:getSuggestions', async (_event, projectId: string) => {
    const evolve = await getEvolve();
    return evolve.getSuggestions(projectId);
  });

  ipcMain.handle('evolve:listExperiences', async (_event, projectId: string) => {
    const evolve = await getEvolve();
    return evolve.listExperiences(projectId);
  });

  ipcMain.handle('evolve:getRuleWeights', async () => {
    const evolve = await getEvolve();
    return evolve.getRuleWeights();
  });
}

function registerEvolveWrites(): void {
  ipcMain.handle(
    'evolve:recordExperience',
    async (_event, entry: Parameters<EvolveEngine['recordExperience']>[0]) => {
      const evolve = await getEvolve();
      return evolve.recordExperience(entry);
    },
  );

  ipcMain.handle('evolve:autoAdjustWeights', async () => {
    const evolve = await getEvolve();
    return evolve.autoAdjustWeights();
  });
}

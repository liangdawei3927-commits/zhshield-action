/**
 * 演进引擎 IPC（ipc/evolve.ts）
 *
 * 建议 / 经验 / 规则权重相关查询与记录。
 */

import { ipcMain } from 'electron';

import type { EvolveEngine } from '@zh/evolve';
import { getEvolve } from '../ipc-context';
import { FEATURE_EVOLVE_ENABLED } from '../../src/feature-flags';

export function registerEvolveIpc(): void {
  registerEvolveQueries();
  registerEvolveWrites();
}

function registerEvolveQueries(): void {
  ipcMain.handle('evolve:getSuggestions', async (_event, projectId: string) => {
    if (!FEATURE_EVOLVE_ENABLED) return [];
    const evolve = await getEvolve();
    return evolve.getSuggestions(projectId);
  });

  ipcMain.handle('evolve:listExperiences', async (_event, projectId: string) => {
    if (!FEATURE_EVOLVE_ENABLED) return [];
    const evolve = await getEvolve();
    return evolve.listExperiences(projectId);
  });

  ipcMain.handle('evolve:getRuleWeights', async () => {
    if (!FEATURE_EVOLVE_ENABLED) return [];
    const evolve = await getEvolve();
    return evolve.getRuleWeights();
  });

  ipcMain.handle('evolve:previewAutoAdjust', async () => {
    if (!FEATURE_EVOLVE_ENABLED) return [];
    return [];
  });
}

function registerEvolveWrites(): void {
  ipcMain.handle(
    'evolve:recordExperience',
    async (_event, entry: Parameters<EvolveEngine['recordExperience']>[0]) => {
      if (!FEATURE_EVOLVE_ENABLED) return;
      const evolve = await getEvolve();
      return evolve.recordExperience(entry);
    },
  );

  ipcMain.handle('evolve:autoAdjustWeights', async () => {
    if (!FEATURE_EVOLVE_ENABLED) return;
    const evolve = await getEvolve();
    return evolve.autoAdjustWeights();
  });
}

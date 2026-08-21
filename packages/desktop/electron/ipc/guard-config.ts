import { ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

interface GuardConfig {
  readonly preCommit: boolean;
  readonly prePush: boolean;
  readonly blockOnCritical: boolean;
}

const DEFAULT_CONFIG: GuardConfig = {
  preCommit: true,
  prePush: true,
  blockOnCritical: true,
};

const CONFIG_FILE = 'guard-config.json';

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
}

async function readConfig(): Promise<GuardConfig> {
  try {
    const data = await fs.readFile(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<GuardConfig>;
    return {
      preCommit: typeof parsed.preCommit === 'boolean' ? parsed.preCommit : DEFAULT_CONFIG.preCommit,
      prePush: typeof parsed.prePush === 'boolean' ? parsed.prePush : DEFAULT_CONFIG.prePush,
      blockOnCritical: typeof parsed.blockOnCritical === 'boolean' ? parsed.blockOnCritical : DEFAULT_CONFIG.blockOnCritical,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

async function writeConfig(config: GuardConfig): Promise<void> {
  await ensureDir();
  await fs.writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

export function registerGuardConfigIpc(): void {
  ipcMain.handle('guard:readConfig', (): Promise<GuardConfig> => readConfig());
  ipcMain.handle('guard:writeConfig', (_event, config: GuardConfig): Promise<void> => writeConfig(config));
}

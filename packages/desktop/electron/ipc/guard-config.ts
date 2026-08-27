import { ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsAsync from 'node:fs/promises';

export interface GuardConfig {
  readonly enabled: boolean;
  readonly preCommit: boolean;
  readonly prePush: boolean;
  readonly blockOnCritical: boolean;
}

export const DEFAULT_CONFIG: GuardConfig = {
  enabled: true,
  preCommit: true,
  prePush: true,
  blockOnCritical: true,
};

const CONFIG_FILE = 'guard-config.json';

function getConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

async function ensureDir(): Promise<void> {
  await fsAsync.mkdir(app.getPath('userData'), { recursive: true });
}

export async function readConfig(): Promise<GuardConfig> {
  try {
    const data = await fsAsync.readFile(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<GuardConfig>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_CONFIG.enabled,
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
  await fsAsync.writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
}

/** 同步读取门禁配置（供流水线子进程等无法使用 IPC 的场景调用） */
export function readGuardConfigFile(): GuardConfig {
  try {
    const data = fs.readFileSync(getConfigPath(), 'utf-8');
    const parsed = JSON.parse(data) as Partial<GuardConfig>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_CONFIG.enabled,
      preCommit: typeof parsed.preCommit === 'boolean' ? parsed.preCommit : DEFAULT_CONFIG.preCommit,
      prePush: typeof parsed.prePush === 'boolean' ? parsed.prePush : DEFAULT_CONFIG.prePush,
      blockOnCritical: typeof parsed.blockOnCritical === 'boolean' ? parsed.blockOnCritical : DEFAULT_CONFIG.blockOnCritical,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function registerGuardConfigIpc(): void {
  ipcMain.handle('guard:readConfig', (): Promise<GuardConfig> => readConfig());
  ipcMain.handle('guard:writeConfig', (_event, config: GuardConfig): Promise<void> => writeConfig(config));
}

/**
 * Scheduler state persistence IPC (ipc/scheduler.ts)
 *
 * Reads / writes scheduler job state to <userData>/.zhshield/scheduler-state.json
 * so scheduled jobs survive app restarts (replaces broken localStorage).
 */
import { app, ipcMain } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';

interface SerializedSchedulerJob {
  id: string;
  config: Record<string, unknown>;
  nextRun: string;
  lastRun?: string;
  lastStatus?: 'success' | 'failure' | 'skipped';
  createdAt: string;
}

interface SchedulerState {
  jobs: SerializedSchedulerJob[];
}

const STATE_DIR = '.zhshield';
const STATE_FILE = 'scheduler-state.json';

function statePath(): string {
  return path.join(app.getPath('userData'), STATE_DIR, STATE_FILE);
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function isValidState(value: unknown): value is SchedulerState {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return 'jobs' in record && Array.isArray(record.jobs);
}

function isEnoentError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const record = err as Record<string, unknown>;
  return record.code === 'ENOENT';
}

export function registerSchedulerIpc(): void {
  ipcMain.handle('scheduler:readState', async (): Promise<SchedulerState> => {
    try {
      const raw = await fs.readFile(statePath(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isValidState(parsed)) {
        return parsed;
      }
      return { jobs: [] };
    } catch (err: unknown) {
      if (isEnoentError(err)) {
        return { jobs: [] };
      }
      console.warn(
        '[scheduler] Failed to read state:',
        err instanceof Error ? err.message : String(err),
      );
      return { jobs: [] };
    }
  });

  ipcMain.handle('scheduler:writeState', async (_event, state: SchedulerState): Promise<void> => {
    try {
      await ensureDir(statePath());
      await fs.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      console.warn(
        '[scheduler] Failed to write state:',
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

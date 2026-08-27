import * as fs from 'fs';
import * as path from 'path';
import type { CheckConfig } from './types';
import { safeJoin } from '@zh/shared';

export class ConfigLoader {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir ?? path.join(__dirname, '..', 'config');
  }

  loadChecks(): CheckConfig[] {
    return this.loadJson<CheckConfig[]>('checks.json') ?? [];
  }

  loadSeverities(): Record<string, { level: string; blocking: boolean }> {
    return this.loadJson<Record<string, { level: string; blocking: boolean }>>('severities.json') ?? {};
  }

  private resolveConfigPath(fileName: string): string {
    return safeJoin(this.configDir, fileName);
  }

  private loadJson<T>(fileName: string): T | null {
    const filePath = this.resolveConfigPath(fileName);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  }
}

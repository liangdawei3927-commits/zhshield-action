import * as fs from 'fs';
import * as path from 'path';
import { safeJoin, safeResolve } from '@zh/shared';

type ConfigValue = string | number | boolean | undefined;

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) return null;
  const key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

function isJsonFile(fileName: string): boolean {
  return fileName.endsWith('.json');
}

export class ConfigManager {
  private cache = new Map<string, ConfigValue>();
  private configDir: string;

  constructor(options?: { configDir?: string }) {
    this.configDir = options?.configDir ?? process.cwd();
  }

  get<T extends ConfigValue = string>(key: string, defaultValue?: T): T {
    const envVal = process.env[key];
    if (envVal !== undefined) {
      return this.castValue(envVal) as T;
    }

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    const fileVal = this.readFromFile(key);
    if (fileVal !== undefined) {
      return fileVal as T;
    }

    return (defaultValue ?? undefined) as T;
  }

  getOrThrow<T extends ConfigValue = string>(key: string): T {
    const val = this.get<T>(key);
    if (val === undefined || val === null || val === '') {
      throw new Error(`[ConfigManager] Required config "${key}" is missing`);
    }
    return val;
  }

  set(key: string, value: ConfigValue): void {
    this.cache.set(key, value);
    if (value !== undefined) {
      process.env[key] = String(value);
    }
  }

  loadEnvFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, val] = parsed;
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }

  loadFromDir(dirName: string = 'config'): void {
    const dir = safeResolve(this.configDir, dirName);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter((f) => this.isConfigFile(f));
    for (const file of files) {
      this.loadConfigFile(safeJoin(dir, file));
    }
  }

  private isConfigFile(fileName: string): boolean {
    return fileName.endsWith('.json') || fileName.endsWith('.yml') || fileName.endsWith('.yaml');
  }

  private loadConfigFile(filePath: string): void {
    if (!isJsonFile(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    for (const [key, val] of Object.entries(data)) {
      if (!this.cache.has(key)) this.cache.set(key, val as ConfigValue);
    }
  }

  private readFromFile(key: string): ConfigValue | undefined {
    const configPath = path.resolve(this.configDir, 'config.json');
    if (!fs.existsSync(configPath)) return undefined;
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return data[key] as ConfigValue | undefined;
    } catch {
      return undefined;
    }
  }

  private castValue(raw: string): ConfigValue {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const num = Number(raw);
    if (!isNaN(num) && raw.trim() !== '') return num;
    return raw;
  }
}

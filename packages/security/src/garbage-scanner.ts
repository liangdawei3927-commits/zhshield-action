import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { GarbageItem, GarbageCleanResult, GarbageRestoreResult, GarbageType } from './types';
import type { Issue } from '@zh/shared';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo',
  '.cache', 'release', 'dist-electron',
]);

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);
const JUNK_EXTS = ['.log', '.tmp', '.bak', '.swp', '.swo'];
const JUNK_PREFIXES = ['npm-debug.log', 'yarn-error.log', 'pnpm-debug.log'];
const EMPTY_FILE_PATTERN = /^(index|main|app)\./i;

export function mapDepcheckIssuesToGarbage(issues: Issue[]): GarbageItem[] {
  return issues
    .filter((i) => i.ruleId.includes('unused') || i.category === 'dependency')
    .map((i) => ({
      id: randomUUID(),
      type: 'unused-dependency' as const,
      path: i.file || i.message,
      size: 0,
      reason: i.message || `Unused dependency: ${i.ruleId}`,
    }));
}

export class GarbageScanner {
  async scan(projectPath: string): Promise<GarbageItem[]> {
    const items: GarbageItem[] = [];

    const isJunkFile = (name: string): boolean => {
      if (JUNK_NAMES.has(name)) return true;
      if (JUNK_EXTS.some((ext) => name.endsWith(ext))) return true;
      if (JUNK_PREFIXES.some((p) => name.startsWith(p))) return true;
      if (name.endsWith('~')) return true;
      return false;
    };

    const scanDir = (dir: string, depth = 0) => {
      if (depth > 14) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) scanDir(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }

        if (isJunkFile(entry.name)) {
          items.push({
            id: randomUUID(),
            type: 'unused-file',
            path: path.relative(projectPath, fullPath),
            size: stat.size,
            reason: `Unwanted file: ${entry.name}`,
          });
          continue;
        }

        // 空文件（非常见入口）视为垃圾候选
        if (stat.size === 0 && !EMPTY_FILE_PATTERN.test(entry.name)) {
          items.push({
            id: randomUUID(),
            type: 'unused-file',
            path: path.relative(projectPath, fullPath),
            size: 0,
            reason: `Empty file: ${entry.name}`,
          });
        }
      }
    };

    scanDir(projectPath);
    return items;
  }
}

export interface GarbageCleanInput {
  id: string;
  path: string;
  size: number;
  type: string;
  reason?: string;
}

function isGarbageType(value: string): value is GarbageType {
  return ['unused-file', 'unused-dependency', 'dead-code', 'duplicate-code'].includes(value);
}

export const scanGarbage = (projectPath: string): Promise<GarbageItem[]> =>
  new GarbageScanner().scan(projectPath);

export function cleanGarbage(projectPath: string, items: GarbageCleanInput[]): GarbageCleanResult {
  const root = path.resolve(projectPath);
  const cleaned: GarbageItem[] = [];
  const failed: string[] = [];
  let batchId = '';
  let trashDir = '';
  let freedBytes = 0;

  for (const item of items) {
    if (!isGarbageType(item.type)) {
      failed.push(`${item.id}: 未知垃圾类型 ${item.type}`);
      continue;
    }
    if (item.type === 'unused-dependency') {
      failed.push(`${item.id}: unused-dependency 需通过包管理器移除，已跳过`);
      continue;
    }
    const absPath = path.resolve(root, item.path);
    if (!absPath.startsWith(root + path.sep)) {
      failed.push(`${item.id}: 越界路径 ${item.path}`);
      continue;
    }
    try {
      if (!batchId) {
        batchId = randomUUID();
        trashDir = path.join(root, '.zhshield', 'trash', batchId);
        fs.mkdirSync(trashDir, { recursive: true });
      }
      const dest = path.join(trashDir, item.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(absPath, dest);
      freedBytes += item.size;
      cleaned.push({ id: item.id, type: item.type, path: item.path, size: item.size, reason: item.reason ?? '' });
    } catch (err) {
      failed.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (cleaned.length === 0 && batchId) {
    fs.rmSync(trashDir, { recursive: true, force: true });
    batchId = '';
  }
  return { batchId, cleaned, freedBytes, failed };
}

export function restoreGarbage(projectPath: string, batchId: string): GarbageRestoreResult {
  const root = path.resolve(projectPath);
  const batchDir = path.join(root, '.zhshield', 'trash', batchId);
  if (!fs.existsSync(batchDir)) {
    throw new Error(`trash batch 不存在: ${batchId}`);
  }

  let restored = 0;
  let restoredBytes = 0;
  const failed: string[] = [];

  const restoreDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        restoreDir(full);
        continue;
      }
      const rel = path.relative(batchDir, full);
      const dest = path.join(root, rel);
      if (fs.existsSync(dest)) {
        failed.push(`${rel}: 目标位置已有文件，跳过恢复`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(full, dest);
      restored += 1;
      restoredBytes += fs.statSync(dest).size;
    }
  };
  restoreDir(batchDir);

  if (failed.length === 0) {
    fs.rmSync(batchDir, { recursive: true, force: true });
  }
  return { restored, restoredBytes, failed };
}

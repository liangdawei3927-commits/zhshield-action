import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { translate, DEFAULT_LANGUAGE, type LanguageCode } from '@zh/i18n';
import type { GarbageItem, GarbageCleanResult, GarbageRestoreResult } from './types';
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

export async function scanGarbage(projectPath: string): Promise<GarbageItem[]> {
  const items: GarbageItem[] = [];
  scanDirectory(projectPath, items, projectPath);
  return items;
}

/** 递归扫描目录，收集垃圾文件条目 */
function scanDirectory(dir: string, items: GarbageItem[], projectPath: string, depth = 0): void {
  if (depth > 14) return;
  const entries = readDirEntries(dir);
  if (!entries) return;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) scanDirectory(fullPath, items, projectPath, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const item = classifyFile(entry.name, fullPath, projectPath);
    if (item) items.push(item);
  }
}

/** 读取目录条目，失败返回 null */
function readDirEntries(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

/** 将单个文件分类为垃圾候选（垃圾文件 / 空文件），否则返回 null */
function classifyFile(name: string, fullPath: string, projectPath: string): GarbageItem | null {
  const stat = statFile(fullPath);
  if (!stat) return null;

  if (isJunkFile(name)) {
    return {
      id: randomUUID(),
      type: 'unused-file',
      path: path.relative(projectPath, fullPath),
      size: stat.size,
      reason: `Unwanted file: ${name}`,
    };
  }

  // 空文件（非常见入口）视为垃圾候选
  if (stat.size === 0 && !EMPTY_FILE_PATTERN.test(name)) {
    return {
      id: randomUUID(),
      type: 'unused-file',
      path: path.relative(projectPath, fullPath),
      size: 0,
      reason: `Empty file: ${name}`,
    };
  }
  return null;
}

/** 读取文件状态，失败返回 null */
function statFile(fullPath: string): fs.Stats | null {
  try {
    return fs.statSync(fullPath);
  } catch {
    return null;
  }
}

function isJunkFile(name: string): boolean {
  if (JUNK_NAMES.has(name)) return true;
  if (JUNK_EXTS.some((ext) => name.endsWith(ext))) return true;
  if (JUNK_PREFIXES.some((p) => name.startsWith(p))) return true;
  if (name.endsWith('~')) return true;
  return false;
}

// ─── 一键清理 / 回收站恢复 ────────────────────────────────────

const TRASH_DIR = '.zhshield/trash';
const MANIFEST_NAME = 'manifest.json';

function trashRoot(projectPath: string): string {
  return path.join(projectPath, TRASH_DIR);
}

/** 目标路径必须位于项目根目录之内，防止恶意相对路径逃逸 */
function isPathInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface TrashManifest {
  batchId: string;
  createdAt: string;
  files: Array<{ relPath: string; size: number }>;
}

function readManifest(batchDir: string): TrashManifest | null {
  const manifestPath = path.join(batchDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as TrashManifest;
  } catch {
    return null;
  }
}

/**
 * 一键清理：将选中的垃圾文件移动至项目内回收站（.zhshield/trash/<batchId>/），
 * 保留原相对路径以便恢复。仅支持文件类型（unused-file）；未用依赖仅给出建议，
 * 不自动修改依赖清单。路径越界 / 文件不存在等条目计入 failed，不阻断其余清理。
 */
export function cleanGarbage(
  projectPath: string,
  items: Array<{ id: string; type: string; path: string; size: number }>,
  locale?: LanguageCode,
): GarbageCleanResult {
  const batchId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const batchDir = path.join(trashRoot(projectPath), batchId);
  const lng = locale ?? DEFAULT_LANGUAGE;

  const cleaned: GarbageCleanResult['cleaned'] = [];
  const failed: string[] = [];
  const manifestFiles: TrashManifest['files'] = [];
  let freedBytes = 0;

  for (const item of items) {
    if (item.type !== 'unused-file') {
      failed.push(translate('engine.security.garbage.typeNotAutoCleanable', lng, { path: item.path, type: item.type }));
      continue;
    }
    const src = path.resolve(projectPath, item.path);
    if (!isPathInside(projectPath, src)) {
      failed.push(translate('engine.security.garbage.pathOutOfBounds', lng, { path: item.path }));
      continue;
    }
    const dest = path.join(batchDir, item.path);
    try {
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        failed.push(translate('engine.security.garbage.fileMissingOrNotFile', lng, { path: item.path }));
        continue;
      }
      if (fs.existsSync(dest)) {
        failed.push(translate('engine.security.garbage.trashNameConflict', lng, { path: item.path }));
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      cleaned.push({ id: item.id, path: item.path, size: item.size });
      manifestFiles.push({ relPath: item.path, size: item.size });
      freedBytes += item.size;
    } catch (err) {
      failed.push(`${item.path}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }

  if (cleaned.length === 0) {
    fs.rmSync(batchDir, { recursive: true, force: true });
    return { batchId: '', cleaned, freedBytes: 0, failed };
  }

  fs.mkdirSync(batchDir, { recursive: true });
  const manifest: TrashManifest = { batchId, createdAt: new Date().toISOString(), files: manifestFiles };
  fs.writeFileSync(path.join(batchDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return { batchId, cleaned, freedBytes, failed };
}

/** 从回收站恢复一个清理批次：文件移回原位置；原位置已存在同名文件时跳过 */
export function restoreGarbage(projectPath: string, batchId: string): GarbageRestoreResult {
  const batchDir = path.join(trashRoot(projectPath), batchId);
  const manifest = readManifest(batchDir);
  if (!manifest) {
    throw new Error(`回收站批次不存在或已损坏: ${batchId}`);
  }

  let restored = 0;
  let restoredBytes = 0;
  const failed: string[] = [];

  for (const f of manifest.files) {
    const src = path.join(batchDir, f.relPath);
    const dest = path.resolve(projectPath, f.relPath);
    try {
      if (!isPathInside(projectPath, dest)) {
        failed.push(`${f.relPath}（路径越界，已拒绝恢复）`);
        continue;
      }
      if (!fs.existsSync(src)) {
        failed.push(`${f.relPath}（回收站文件缺失）`);
        continue;
      }
      if (fs.existsSync(dest)) {
        failed.push(`${f.relPath}（原位置已有文件，已跳过）`);
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
      restored += 1;
      restoredBytes += f.size;
    } catch (err) {
      failed.push(`${f.relPath}（${err instanceof Error ? err.message : String(err)}）`);
    }
  }

  if (failed.length === 0) {
    fs.rmSync(batchDir, { recursive: true, force: true });
  } else {
    const remaining = manifest.files.filter((f) => failed.some((msg) => msg.startsWith(f.relPath)));
    fs.writeFileSync(
      path.join(batchDir, MANIFEST_NAME),
      JSON.stringify({ ...manifest, files: remaining }, null, 2),
    );
  }
  return { restored, restoredBytes, failed };
}

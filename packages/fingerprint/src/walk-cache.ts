// walk-cache.ts — walkFiles 的增量缓存 + 单飞（single-flight）记忆化。
//
// 正确性契约：缓存绝不允许返回与冷全量遍历不同的文件列表。
// 关键洞察：walkFiles 只返回文件路径列表（不读内容），因此文件列表仅在
// 「目录条目增删改名」时变化；文件内容变化不影响列表。故树结构签名基于
// 目录条目名（name+type）而非 mtime —— 天然免疫 git checkout 恢复旧 mtime
// 造成的脏命中（mtime 匹配但内容/条目已变）。
//
// 两层缓存：
//   1) 进程内记忆化（单飞）：同一进程短窗口内对同一 root 的重复 walkFiles
//      共享一次遍历（4 个探测器并行调用 walkFiles 时只走一次）。
//   2) 持久 SQLite 缓存（~/.zhshield/perf-cache/）：跨进程复用文件列表，
//      用树结构签名校验；签名未变 → 复用，签名变化 → 全量重建。
//
// fail-open：任何 DB 错误 / 权限问题 / 损坏条目 → 静默回退全量遍历，
// 绝不抛入探测器，绝不破坏指纹识别。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DbConnection } from '@zh/db';
import { SKIP_DIRS } from './detector';

// better-sqlite3 类型内联（避免 native 模块在非 Electron 环境下的构建问题，
// 与 kernel sop-sqlite-store 一致）。仅声明本模块用到的子集。
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
interface Statement {
  run(...params: unknown[]): { changes: number };
  get<T = unknown>(...params: unknown[]): T | undefined;
}

/** 进程内记忆化 TTL（毫秒）：同一进程内短窗口内重复调用共享一次遍历。 */
const MEMO_TTL_MS = 1000;

/** 缓存目录（可用 ZHSHIELD_PERF_CACHE_DIR 覆盖，测试隔离用）。 */
function cacheDir(): string {
  const override = process.env.ZHSHIELD_PERF_CACHE_DIR;
  return override && override.length > 0
    ? override
    : path.join(os.homedir(), '.zhshield', 'perf-cache');
}

interface MemoEntry {
  readonly files: string[];
  readonly at: number;
}

/** 进程内记忆化表：key = root + '\u0000' + maxDepth。 */
const memo = new Map<string, MemoEntry>();

let db: Database | null = null;
let dbErrorLogged = false;

/** 惰性打开持久缓存；任何失败 → 返回 null（fail-open，禁用持久缓存）。 */
function getDb(): Database | null {
  if (db) return db;
  try {
    const conn = new DbConnection({
      dbPath: path.join(cacheDir(), 'walk-cache.db'),
      walMode: true,
    });
    db = conn.connect() as unknown as Database;
    db.exec(`
      CREATE TABLE IF NOT EXISTS walk_index (
        root       TEXT PRIMARY KEY,
        max_depth  INTEGER NOT NULL,
        sig        TEXT NOT NULL,
        files      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  } catch (err) {
    // fail-open：无法打开/建表（权限、只读、路径非法等）→ 禁用持久缓存，回退全量遍历
    if (!dbErrorLogged) {
      console.log(
        '[walk-cache] persistent cache disabled, falling back to full walk:',
        err instanceof Error ? err.message : String(err),
      );
      dbErrorLogged = true;
    }
    db = null;
  }
  return db;
}

interface CachedEntry {
  readonly sig: string;
  readonly files: string[];
}

/** 读取某 root 的缓存条目；无条目 / 损坏 / 出错 → 返回 null（fail-open）。 */
function loadCached(root: string, maxDepth: number): CachedEntry | null {
  const d = getDb();
  if (!d) return null;
  try {
    const row = d
      .prepare('SELECT sig, files FROM walk_index WHERE root = ? AND max_depth = ?')
      .get(root, maxDepth) as { sig: string; files: string } | undefined;
    if (!row) return null;
    const parsed: unknown = JSON.parse(row.files);
    if (!Array.isArray(parsed) || !parsed.every((f) => typeof f === 'string')) {
      // 损坏条目 → 视为未命中，回退全量遍历
      return null;
    }
    return { sig: row.sig, files: parsed as string[] };
  } catch {
    // 读取失败 → fail-open
    return null;
  }
}

/** 写入缓存条目；失败静默忽略（不影响本次遍历结果）。 */
function storeCached(root: string, maxDepth: number, sig: string, files: string[]): void {
  const d = getDb();
  if (!d) return;
  try {
    d.prepare(
      'INSERT OR REPLACE INTO walk_index (root, max_depth, sig, files, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(root, maxDepth, sig, JSON.stringify(files), Date.now());
  } catch {
    // 写入失败 → fail-open（不影响本次遍历结果）
  }
}

/**
 * 单次遍历：计算树结构签名（目录条目名 name+type），可选收集文件列表。
 * 与 walkFiles 共用同一套跳过规则（SKIP_DIRS / 符号链接 / maxDepth / 排序）。
 * collectFiles 仅影响是否 push 文件路径，不影响签名 —— 校验与重建签名一致。
 */
function walkAndSign(
  root: string,
  maxDepth: number,
  collectFiles: boolean,
): { sig: string; files: string[] } {
  const files: string[] = [];
  const hash = createHash('sha1');
  const walk = (relDir: string, depth: number): void => {
    if (depth > maxDepth) return;
    const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const desc: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        desc.push(entry.name + 'D');
        const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
        walk(rel, depth + 1);
      } else if (entry.isFile()) {
        desc.push(entry.name + 'F');
        if (collectFiles) files.push(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      }
    }
    hash.update(relDir + '\u0000' + desc.join('\u0001') + '\n');
  };
  walk('', 0);
  return { sig: hash.digest('hex'), files };
}

/**
 * 缓存感知的 walkFiles 实现。返回与冷全量遍历完全一致的文件列表；
 * 任何缓存失败都回退全量遍历，绝不抛错。
 */
export function cachedWalkFiles(root: string, maxDepth: number): string[] {
  const memoKey = `${root}\u0000${maxDepth}`;

  // 1) 进程内记忆化（单飞）：短窗口内重复调用共享一次遍历
  const m = memo.get(memoKey);
  if (m && Date.now() - m.at < MEMO_TTL_MS) return m.files;

  // 2) 持久缓存：加载已存签名，若树结构签名未变则复用文件列表（免全量枚举）
  const cached = loadCached(root, maxDepth);
  if (cached) {
    const sig = walkAndSign(root, maxDepth, false).sig;
    if (sig === cached.sig) {
      memo.set(memoKey, { files: cached.files, at: Date.now() });
      return cached.files;
    }
    // 签名变化 → 树结构已变，回退全量遍历重建
  }

  // 3) 全量遍历（同时计算签名），写回缓存
  const { sig, files } = walkAndSign(root, maxDepth, true);
  storeCached(root, maxDepth, sig, files);
  memo.set(memoKey, { files, at: Date.now() });
  return files;
}

/** 测试辅助：清空进程内记忆化并关闭/重置持久缓存（避免跨测试污染）。 */
export function resetWalkCache(): void {
  memo.clear();
  if (db) {
    try {
      db.close();
    } catch {
      // 关闭失败可忽略
    }
    db = null;
  }
  dbErrorLogged = false;
}

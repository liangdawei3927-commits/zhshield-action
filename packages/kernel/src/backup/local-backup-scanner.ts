/**
 * 一键备份系统 — 本地目录文件扫描（排除项过滤 + 中止信号）
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { matchesExcludePattern } from './utils';

/** 递归扫描深度上限：防止病态深层目录树导致栈溢出 */
const MAX_SCAN_DEPTH = 64;

export class LocalBackupScanner {
  async scanFiles(
    rootDir: string,
    excludePatterns: string[],
    abortSignal?: AbortSignal,
  ): Promise<string[]> {
    const results: string[] = [];
    await this.collectFiles(rootDir, rootDir, excludePatterns, abortSignal, results);
    return results;
  }

  /** 递归收集文件路径（跳过排除项、中止信号与深度上限） */
  private async collectFiles(
    dir: string,
    rootDir: string,
    excludePatterns: string[],
    abortSignal: AbortSignal | undefined,
    results: string[],
    depth = 0,
  ): Promise<void> {
    if (abortSignal?.aborted || depth > MAX_SCAN_DEPTH) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (abortSignal?.aborted) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (matchesExcludePattern(relativePath, excludePatterns)) continue;
      if (entry.isDirectory()) {
        // perf rule false positive: arg depends on loop var via dataflow
        // eslint-disable-next-line perf/perf-no-serial-await
        await this.collectFiles(
          fullPath,
          rootDir,
          excludePatterns,
          abortSignal,
          results,
          depth + 1,
        );
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
}

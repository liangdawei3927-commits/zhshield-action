/**
 * 一键备份系统 — 本地目录文件扫描（排除项过滤 + 中止信号）
 *
 * 从 LocalBackup 拆出，保持单类行数与职责可控。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { matchesExcludePattern } from './utils';

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

  /** 递归收集文件路径（跳过排除项与中止信号） */
  private async collectFiles(
    dir: string,
    rootDir: string,
    excludePatterns: string[],
    abortSignal: AbortSignal | undefined,
    results: string[],
  ): Promise<void> {
    if (abortSignal?.aborted) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (abortSignal?.aborted) return;
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);
      if (matchesExcludePattern(relativePath, excludePatterns)) continue;
      if (entry.isDirectory()) {
        await this.collectFiles(fullPath, rootDir, excludePatterns, abortSignal, results);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }
}

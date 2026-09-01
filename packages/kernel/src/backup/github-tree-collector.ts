/**
 * GitHub 备份 — Git Tree 条目收集
 *
 * 从 GitHubBackup 拆出的独立模块：递归收集目录树条目，
 * 跳过排除项并响应中止信号。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GitHubApiContext, GitHubTreeItem } from './github-api-types';
import { matchesExcludePattern } from './utils';

/** 递归收集目录树条目（跳过排除项与中止信号） */
export async function collectTreeItems(
  ctx: GitHubApiContext,
  dir: string,
  prefix: string,
  excludePatterns: string[],
  tree: GitHubTreeItem[],
): Promise<void> {
  if (ctx.abortSignal?.aborted) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (ctx.abortSignal?.aborted) return;
    const fullPath = path.join(dir, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (matchesExcludePattern(relativePath, excludePatterns)) continue;
    if (entry.isDirectory()) {
      // perf rule false positive: arg depends on loop var via dataflow
      // eslint-disable-next-line perf/perf-no-serial-await
      await collectTreeItems(ctx, fullPath, relativePath, excludePatterns, tree);
    } else if (entry.isFile()) {
      // perf rule false positive: arg depends on loop var via dataflow
      // eslint-disable-next-line perf/perf-no-serial-await
      const content = await fs.readFile(fullPath, 'base64');
      tree.push({
        path: relativePath,
        mode: '100644',
        type: 'blob',
        content,
      });
    }
  }
}

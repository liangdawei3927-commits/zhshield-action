import { relative } from 'node:path';

import type { RuleContext } from '../sop/_meta/rule-context';
import { resolveFiles, readFileSafe, matchesExcludePatterns } from './scan-utils';

// ─── 内联评估：共享文件遍历骨架 ─────────────────────────

/**
 * 遍历待扫描文件并交给 visit 消费：按 fileExts 解析文件列表 → 读取内容（不可读跳过）→
 * 相对化路径 → excludePatterns 过滤。pattern-scan / forbidden / required-content /
 * layer-boundary 四个内联评估器的文件遍历骨架逐字相同，收敛为唯一实现。
 */
export function forEachScanTarget(
  context: RuleContext,
  fileExts: string[] | undefined,
  excludePatterns: string[] | undefined,
  visit: (content: string, relativePath: string) => void,
): void {
  for (const filePath of resolveFiles(context, fileExts)) {
    const content = readFileSafe(filePath);
    if (content === null) continue;
    const relativePath = relative(context.repoRoot, filePath);
    if (matchesExcludePatterns(relativePath, excludePatterns)) continue;
    visit(content, relativePath);
  }
}

/**
 * 备份包共享工具 — 抽取各备份类重复的 hash / 排除匹配逻辑
 */
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';

/** 计算文件 SHA-256 哈希 */
export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const content = await fs.readFile(filePath);
  hash.update(content);
  return hash.digest('hex');
}

/** 判断相对路径是否命中排除模式 */
export function matchesExcludePattern(relativePath: string, excludePatterns: string[]): boolean {
  return excludePatterns.some((pattern) => {
    if (pattern.endsWith('/')) {
      return relativePath.startsWith(pattern) || relativePath.includes(`/${pattern}`);
    }
    if (pattern.startsWith('*.')) {
      return relativePath.endsWith(pattern.slice(1));
    }
    return relativePath === pattern;
  });
}

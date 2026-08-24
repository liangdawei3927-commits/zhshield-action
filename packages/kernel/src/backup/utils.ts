/**
 * 备份包共享工具 — 抽取各备份类重复的 hash / 排除匹配逻辑
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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

/** 清洗为可安全用作单层目录名的片段（去除路径分隔符与文件系统保留字符，限长64） */
export function sanitizeDirSegment(input: string): string {
  const cleaned = input
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .trim();
  return (cleaned.slice(0, 64) || 'project');
}

/**
 * 项目备份子目录段：`<可读名>-<路径sha1前8位>`；哈希保证同名不同路径的项目互不共享目录。
 * 可读名优先 projectName，回退 projectPath basename；无任何标识时返回 undefined（调用方回退共享根目录）。
 */
export function projectBackupSegment(
  projectPath?: string,
  projectName?: string,
): string | undefined {
  const trimmedName = projectName?.trim();
  const trimmedPath = projectPath?.trim();
  const effectiveName = trimmedName && trimmedName !== trimmedPath ? trimmedName : '';
  const readable = effectiveName || (trimmedPath ? path.basename(trimmedPath) : '');
  if (!trimmedPath && !readable) return undefined;

  const safeName = sanitizeDirSegment(readable);
  if (!trimmedPath) return safeName;

  const hash = crypto.createHash('sha1').update(trimmedPath).digest('hex').slice(0, 8);
  return `${safeName}-${hash}`;
}

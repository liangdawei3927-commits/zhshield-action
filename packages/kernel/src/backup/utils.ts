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
    // 形如 '.env*'：按 basename 前缀匹配，使该模式在任意深度生效。
    // 缺少这一形式时，兜底的精确相等只能排除根级同名文件，嵌套目录（如 packages/x/.env）
    // 仍会被打进备份包——密钥泄露面被静默保留。
    if (pattern.endsWith('*') && !pattern.startsWith('*')) {
      const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
      return base.startsWith(pattern.slice(0, -1));
    }
    return relativePath === pattern;
  });
}

/** P2-6：估算待备份文件总字节数（纯求和，单文件 stat 失败按 0 计不阻断） */
export async function estimateFilesTotalSize(files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    // perf rule false positive: arg depends on loop var via dataflow
    // eslint-disable-next-line perf/perf-no-serial-await
    const s = await fs.stat(file).catch(() => null);
    total += s?.size ?? 0;
  }
  return total;
}

/**
 * P2-6：体积上限判定（纯函数便于单测）。
 * 超限返回面向用户的处置提示——上限来自配置 maxTotalSizeMB（默认 512），
 * 解法是收窄 excludePatterns 或调大上限，绝不静默打爆磁盘。
 */
export function backupSizeLimitError(totalBytes: number, limitMB: number): string | null {
  if (!Number.isFinite(limitMB) || limitMB <= 0 || totalBytes <= limitMB * 1024 * 1024) {
    return null;
  }
  const totalGB = (totalBytes / 1024 ** 3).toFixed(1);
  return `待备份内容 ${totalGB}GB 超过单次快照上限 ${limitMB}MB：请在备份设置中排除大目录（如 node_modules/dist/.zhshield）或调大 maxTotalSizeMB 后重试`;
}

/** 清洗为可安全用作单层目录名的片段（去除路径分隔符与文件系统保留字符，限长64） */
export function sanitizeDirSegment(input: string): string {
  const cleaned = input
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .trim();
  return cleaned.slice(0, 64) || 'project';
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

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 递归收集源码文件（门禁扫描类适配器的唯一遍历实现）。
 *
 * 架构边界与安全扫描适配器此前各自复制一份只读目录项的递归收集骨架，仅「排除目录集」
 * 与「文件后缀判定」两处口径不同；此处把遍历收成唯一实现，两处口径由调用方注入。
 *
 * 语义保持一致：目录不可读（权限/竞态删除）时返回已收集结果而非抛错；隐藏目录
 * （以 `.` 开头）一律跳过，不展开也不参与文件收集。
 */
export function collectSourceFiles(
  dir: string,
  isExcludedDir: (name: string) => boolean,
  acceptFile: (name: string) => boolean,
): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (isExcludedDir(entry.name) || entry.name.startsWith('.')) continue;
      files.push(...collectSourceFiles(fullPath, isExcludedDir, acceptFile));
      continue;
    }
    if (acceptFile(entry.name)) files.push(fullPath);
  }
  return files;
}

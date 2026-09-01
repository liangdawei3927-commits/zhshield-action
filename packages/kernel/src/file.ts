import * as fs from 'fs';
import * as path from 'path';
import { safeJoin } from '@zh/shared';
import picomatch from 'picomatch';

/** 噪声目录：递归 glob 时跳过，避免遍历依赖/构建产物（与 scan-utils 的 NOISE_DIRS 对齐） */
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'release',
  '.turbo',
  '.cache',
]);

export class FileHelper {
  static async readJSON(filePath: string): Promise<unknown> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  static async writeJSON(filePath: string, data: unknown, indent: number = 2): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, indent), 'utf-8');
  }

  static async ensureDir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }

  static async copy(src: string, dest: string): Promise<void> {
    await this.ensureDir(path.dirname(dest));
    await fs.promises.copyFile(src, dest);
  }

  static async glob(pattern: string, dir: string): Promise<string[]> {
    const isMatch = picomatch(pattern);
    const results: string[] = [];

    const walk = async (currentDir: string): Promise<void> => {
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = await fs.promises.readdir(currentDir, { withFileTypes: true });
      } catch {
        // 忽略无权限/不存在的目录
        return;
      }
      for (const entry of dirEntries) {
        const fullPath = safeJoin(currentDir, entry.name);
        if (entry.isDirectory()) {
          // 跳过噪声目录与点开头目录（含 .git），不深入遍历
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          // perf rule false positive: arg depends on loop var via dataflow
          // eslint-disable-next-line perf/perf-no-serial-await
          await walk(fullPath);
        } else if (entry.isFile()) {
          // 相对路径统一用 '/' 分隔，与 picomatch 的 glob 语义对齐
          const relativePath = path.relative(dir, fullPath).split(path.sep).join('/');
          if (isMatch(relativePath)) {
            results.push(fullPath);
          }
        }
      }
    };

    await walk(dir);
    return results;
  }

  static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

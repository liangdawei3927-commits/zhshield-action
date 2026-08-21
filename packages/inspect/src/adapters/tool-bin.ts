import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * 在 startDir 自身、其一层子目录（嵌套仓库，如外层 guard 目录下的 monorepo）及各级父目录中
 * 查找 node_modules/.bin/<tool>，返回绝对路径；未找到返回 null。
 */
export function findLocalToolBin(tool: string, startDir: string): string | null {
  const candidates = new Set<string>([startDir]);

  try {
    for (const entry of fs.readdirSync(startDir)) {
      try {
        if (fs.statSync(path.join(startDir, entry)).isDirectory()) {
          candidates.add(path.join(startDir, entry));
        }
      } catch {
        // 忽略损坏的符号链接 / 无权限目录
      }
    }
  } catch {
    // startDir 不可读时仅保留自身
  }

  let dir = path.dirname(startDir);
  while (dir !== path.dirname(dir)) {
    candidates.add(dir);
    dir = path.dirname(dir);
  }

  for (const dir of candidates) {
    const bin = path.join(dir, 'node_modules', '.bin', tool);
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {
      // 继续下一个候选目录
    }
  }
  return null;
}

/**
 * 解析工具命令：优先 PATH 中的全局工具，否则回退到项目本地 node_modules/.bin
 * （pnpm/yarn 等将工具安装为项目本地依赖，未进入全局 PATH）。
 * 返回裸命令名或本地 .bin 的绝对路径；两者都不可用时返回裸命令名，由调用方按 ENOENT 处理。
 */
export async function resolveToolCommand(tool: string, startDir?: string): Promise<string> {
  try {
    await execFileAsync(tool, ['--version'], { timeout: 5000 });
    return tool;
  } catch {
    const local = findLocalToolBin(tool, startDir ?? process.cwd());
    if (local) return local;
  }
  return tool;
}

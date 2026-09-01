import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

/**
 * 在 startDir 自身、其一层子目录（嵌套仓库，如外层 guard 目录下的 monorepo）及各级父目录中
 * 查找 node_modules/.bin/<tool>，返回绝对路径；未找到返回 null。
 */
/** 单个目录项：若是目录则加入候选集（stat 失败忽略） */
function addSubdirCandidate(startDir: string, entry: string, candidates: Set<string>): void {
  try {
    if (fs.statSync(path.join(startDir, entry)).isDirectory()) {
      candidates.add(path.join(startDir, entry));
    }
  } catch {
    // 忽略损坏的符号链接 / 无权限目录
  }
}

/** 收集 startDir 自身及其一层子目录作为候选 */
function collectSubdirCandidates(startDir: string): Set<string> {
  const candidates = new Set<string>([startDir]);

  try {
    for (const entry of fs.readdirSync(startDir)) {
      if (entry === 'node_modules') continue;
      addSubdirCandidate(startDir, entry, candidates);
    }
  } catch {
    // startDir 不可读时仅保留自身
  }

  return candidates;
}

/** 收集 startDir 各级父目录作为候选 */
function collectParentCandidates(startDir: string): Set<string> {
  const candidates = new Set<string>();

  let dir = path.dirname(startDir);
  while (dir !== path.dirname(dir)) {
    candidates.add(dir);
    dir = path.dirname(dir);
  }

  return candidates;
}

/** 合并子目录与父目录候选 */
function collectCandidateDirs(startDir: string): Set<string> {
  const candidates = collectSubdirCandidates(startDir);
  for (const dir of collectParentCandidates(startDir)) {
    candidates.add(dir);
  }
  return candidates;
}

export function findLocalToolBin(tool: string, startDir: string): string | null {
  const candidates = collectCandidateDirs(startDir);

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

/** 用户级共享工具目录（install-tools.mjs 的安装目标，CLI/桌面端共用） */
export function getZhshieldToolBinDir(): string {
  return path.join(os.homedir(), '.zhshield', 'bin');
}

/** 查找 zhshield 共享工具目录中的工具，未找到返回 null（目录缺失/无权限时静默跳过） */
export function findZhshieldToolBin(tool: string): string | null {
  const bin = path.join(getZhshieldToolBinDir(), tool);
  try {
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/**
 * 解析工具命令：优先 PATH 中的全局工具，其次项目本地 node_modules/.bin
 * （pnpm/yarn 等将工具安装为项目本地依赖，未进入全局 PATH），
 * 最后回退到 zhshield 共享工具目录 ~/.zhshield/bin（install-tools.mjs 安装目标）。
 * 均不可用时返回裸命令名，由调用方按 ENOENT 处理。
 */
export async function resolveToolCommand(tool: string, startDir?: string): Promise<string> {
  try {
    await execFileAsync(tool, ['--version'], { timeout: 5000 });
    return tool;
  } catch {
    const local = findLocalToolBin(tool, startDir ?? process.cwd());
    if (local) return local;
    const shared = findZhshieldToolBin(tool);
    if (shared) return shared;
  }
  return tool;
}

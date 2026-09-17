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

/** 工具命令解析结果的来源，供适配器如实上报"用的是哪一份工具" */
export type ToolCommandOrigin = 'project-local' | 'shared' | 'path' | 'unresolved';

export interface ResolvedToolCommand {
  command: string;
  origin: ToolCommandOrigin;
}

/**
 * 解析工具命令：优先项目本地 node_modules/.bin（与该仓库构建所用版本一致，
 * 例如 tsc 使用项目锁定的版本而非全局更新的版本），其次 zhshield 共享工具目录
 * ~/.zhshield/bin（install-tools.mjs 安装目标/按需能力分发的落点），最后才是
 * PATH 中的全局工具。均不可用时返回裸命令名，由调用方按 ENOENT 处理。
 *
 * 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：startDir 缺失时不再回落
 * process.cwd()，保证解析结果与进程工作目录无关。
 *
 * P1（复查5）：共享目录与 PATH 的顺序此前是反的（PATH 在前）。这是个真实缺陷——
 * PATH 上的全局工具是"碰巧存在"的任意版本，而 ~/.zhshield/bin 是智汇码盾自己
 * 安装、版本可控的。实证：项目无本地 depcruise 时会采用全局 18.1.1，该版本读不出
 * TypeScript 依赖图（modules=0，0 检出）；而 18.2.0（本项目本地/码盾安装版本）
 * 同一 fixture 可正常检出 18 个模块、1 条循环依赖。把不可控的全局版本排在产品
 * 自装版本之前，等于让用户的 PATH 决定产品能力。
 */
export async function resolveToolCommandDetailed(
  tool: string,
  startDir?: string,
  options?: { probeTimeoutMs?: number },
): Promise<ResolvedToolCommand> {
  const local = startDir ? findLocalToolBin(tool, startDir) : null;
  if (local) return { command: local, origin: 'project-local' };

  const shared = findZhshieldToolBin(tool);
  if (shared) return { command: shared, origin: 'shared' };

  try {
    // 20s：semgrep 等 Python 工具冷启动 --version 可达 7.6s，5s 会误判 PATH 不可用。
    // 批量探测场景（如桌面端工具就绪面板一次探 10 个工具）可传更短的值控制总耗时。
    await execFileAsync(tool, ['--version'], { timeout: options?.probeTimeoutMs ?? 20000 });
    return { command: tool, origin: 'path' };
  } catch {
    return { command: tool, origin: 'unresolved' };
  }
}

/**
 * resolveToolCommand — resolveToolCommandDetailed 的兼容薄封装。
 * 需要知道"用的是哪一份工具"的新代码请直接用 resolveToolCommandDetailed。
 */
export async function resolveToolCommand(tool: string, startDir?: string): Promise<string> {
  return (await resolveToolCommandDetailed(tool, startDir)).command;
}

/**
 * 工具命令解析 — 共享单一事实源
 *
 * ⚠️ 唯一 owner：所有需要定位外部工具二进制的消费方都从这里解析，不得各自实现。
 *
 * 背景（P0-6 工具消费路径不统一）：此前 Inspect 走「项目本地 → 码盾目录 → PATH」，
 * 而 Security / Guard 用裸命令（只认 PATH）。同一份工具装进 ~/.zhshield/bin 后，
 * 工具就绪面板显示「已就绪」（走 Inspect 解析），点安全中心却报「未安装」（走裸命令）
 * —— 用户唯一能想到的解法就是「再装一遍」。
 *
 * 解析顺序（顺序本身是修复的一部分，勿调换）：
 *   1. 项目本地 node_modules/.bin —— 与该仓库锁定版本一致
 *   2. ~/.zhshield/bin —— 码盾自己安装、版本可控（install-tools.mjs 落点）
 *   3. PATH —— 「碰巧存在」的任意版本，最后兜底
 *
 * 为什么码盾目录必须排在 PATH 之前（P1 复查5 实证）：项目无本地 depcruise 时，
 * PATH 上若是全局 18.1.1 → 读不出 TypeScript 依赖图（modules=0、0 检出）；
 * 而 18.2.0（码盾安装版本）同一 fixture 可正常检出 18 个模块、1 条循环依赖。
 * 把不可控的全局版本排在产品自装版本之前，等于让用户的 PATH 决定产品能力。
 *
 * 本模块自 @zh/inspect 的 adapters/tool-bin.ts 下沉而来（该文件现改为 re-export），
 * 使 Security / Guard 无需依赖 @zh/inspect（后者还拖着 @zh/dependency、@zh/i18n）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

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

/**
 * 在 startDir 自身、其一层子目录（嵌套仓库，如外层目录下的 monorepo）及各级父目录中
 * 查找 node_modules/.bin/<tool>，返回绝对路径；未找到返回 null。
 */
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

/** 查找码盾共享工具目录中的工具，未找到返回 null（目录缺失/无权限时静默跳过） */
export function findZhshieldToolBin(tool: string): string | null {
  const bin = path.join(getZhshieldToolBinDir(), tool);
  try {
    return fs.existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** 工具命令解析结果的来源，供适配器如实上报「用的是哪一份工具」 */
export type ToolCommandOrigin = 'project-local' | 'shared' | 'path' | 'unresolved';

export interface ResolvedToolCommand {
  command: string;
  origin: ToolCommandOrigin;
}

/**
 * 解析工具命令。锚定 projectPath，不受 cwd 影响：startDir 缺失时跳过本地 bin 查找，
 * 保证解析结果与进程工作目录无关（否则同一 --dir 在不同 cwd 下会解析到不同版本）。
 * 均不可用时返回裸命令名且 origin='unresolved'，由调用方决定降级语义。
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
 * 需要知道「用的是哪一份工具」的新代码请直接用 resolveToolCommandDetailed。
 */
export async function resolveToolCommand(tool: string, startDir?: string): Promise<string> {
  return (await resolveToolCommandDetailed(tool, startDir)).command;
}

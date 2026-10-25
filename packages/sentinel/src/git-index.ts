/**
 * 交付物索引（git-index.ts）——判断一条路径是否属于**版本库跟踪的文件**。
 *
 * 为什么需要：`file-monitor` 原先对「监控目录下任何已知文件消失」一律报 p2。
 * 2026-10-25 复盘 18 条 p2 `File unlink` 事件（`.probe.cjs`、`tmp-preview.tsx`、
 * `.pnpm-lock.yaml.*.tmp`、`.probe-sentinel-db.ts` …）全部是**未跟踪的临时/探针
 * 文件**被删 —— 删除属实，但没有一条需要用户处理。`git status` 里 ` D` 计数为 0
 * 即证明：没有任何交付物真的丢了。
 *
 * 结论：unlink 的告警价值只在「交付物消失了」。这个判据不能靠堆正则
 * （`tmp-*` / `.probe*` / `*.tmp` 列举永远追不上代理工具新造的临时文件名），
 * 必须换成语义信号 —— 该路径在不在 git 索引里。
 *
 * ## 锚点必须是「该文件最近的仓库」，不是监控根
 *
 * 监控根与仓库边界不一定重合：本产品监控的是**外层文档仓库**
 * （`Desktop/ZHCodeShield`），而代码在内层独立仓库 `zhihui-codeshield/`
 * （被外层 `.gitignore` 排除）。若只在监控根上跑一次 `git ls-files`，内层仓库里
 * **已跟踪的源文件**会全部查不到 ⇒ 被判成「未跟踪」⇒ 真实删除被降级成 p3
 * 信息类事件并从列表里消失。这是比噪音严重得多的**假阴性**（2026-10-25 实测：
 * 内层 `file-monitor.ts` 的 `isTracked` 曾返回 false）。
 *
 * 因此索引一律从**目标路径自身向上**找最近的 `.git`，在该仓库上取索引，
 * 相对路径也相对该仓库计算。监控路径下有几个嵌套仓库就有几份索引（带缓存）。
 *
 * 失败一律 fail-open（返回 null，由调用方保持原 p2 行为）：
 * 看不到索引时宁可多报，不可把真实的交付物删除吞掉。
 */

import { execFile, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** git 子进程超时：索引查询发生在监控热路径上，不能挂死 */
const GIT_TIMEOUT_MS = 5000;
/** `git ls-files -z` 输出上限（本项目实测最大约 4k 条路径，留足余量） */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** 索引缓存有效期：轮询间隔 5s，30s 足够命中同一批删除事件而又不至于用到陈旧索引 */
export const GIT_INDEX_TTL_MS = 30_000;
/** 向上找 `.git` 的最大层数：防止异常路径下一路 stat 到根 */
const MAX_REPO_WALK_DEPTH = 32;

/** git 不认反斜杠，路径统一转正斜杠 */
function toGitPath(rel: string): string {
  return rel.split(path.sep).join('/');
}

/** 解析 `git ls-files -z` 的 NUL 分隔输出 */
function parseIndex(stdout: string): Set<string> {
  const files = new Set<string>();
  for (const raw of stdout.split('\0')) {
    if (raw.length > 0) files.add(raw);
  }
  return files;
}

/**
 * 从 `dir` 起向上找最近的 git 仓库根（含 `.git` 的目录）。
 *
 * `.git` 可能是目录（普通仓库）也可能是文件（worktree / submodule），
 * 用 `existsSync` 两者都认。找不到返回 null —— 表示「不在任何版本库里」。
 */
export function findRepoRootFor(dir: string): string | null {
  let current = path.resolve(dir);
  for (let depth = 0; depth < MAX_REPO_WALK_DEPTH; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * 同步读取索引（供应用启动期的一次性历史收敛使用，此时阻塞可接受）。
 * 非 git 仓库 / git 不可执行 / 超时 → null，表示**不可判定**。
 */
export function readGitIndexSync(root: string): Set<string> | null {
  try {
    const stdout = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseIndex(stdout);
  } catch {
    return null;
  }
}

/** 异步读取索引（供文件监控热路径使用，不阻塞事件循环） */
export function readGitIndex(root: string): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, 'ls-files', '-z'],
      { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        resolve(parseIndex(stdout));
      },
    );
  });
}

/**
 * 该路径是否属于交付物：自身被跟踪，或（目录形态时）其下存在被跟踪的文件。
 *
 * 目录形态必须支持：整树删除会被折叠成一条以**目录**为目标的 unlink 事件
 * （见 `file-monitor` 的 `findRemovedRoot`），此时 `pnpm` 索引里只有文件、
 * 没有该目录本身，只看精确命中会把「整个包被删」误判成未跟踪。
 *
 * `root` 必须是**包含该路径的那个仓库根**（见 `findRepoRootFor`），
 * 不是监控根 —— 否则嵌套仓库里的路径会被全部判成未跟踪。
 */
export function hasTrackedUnder(
  files: ReadonlySet<string>,
  root: string,
  fullPath: string,
): boolean {
  const rel = toGitPath(path.relative(root, fullPath));
  if (rel.length === 0) return files.size > 0;
  if (rel.startsWith('..')) return false;
  if (files.has(rel)) return true;
  const prefix = `${rel}/`;
  for (const file of files) {
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * 带 TTL 缓存的索引查询器：同一仓库上的一批删除事件只跑一次 git。
 * 单次失败不缓存失败态以外的结论（缓存 null 同样遵守 TTL，避免每个事件都去 spawn git）。
 *
 * 仓库根解析同样按目录缓存：一条 unlink 事件要做一次「向上找 .git」，
 * 同一目录下的一批文件不应重复 stat。
 */
export class GitIndexCache {
  private readonly indexes = new Map<string, { at: number; files: Set<string> | null }>();
  private readonly repoRoots = new Map<string, { at: number; root: string | null }>();

  constructor(private readonly ttlMs: number = GIT_INDEX_TTL_MS) {}

  /** 目标所在仓库根（按目录缓存；已删除路径也能解析，只看现存祖先） */
  resolveRepoFor(fullPath: string): string | null {
    const dir = path.dirname(path.resolve(fullPath));
    const hit = this.repoRoots.get(dir);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.root;
    const root = findRepoRootFor(dir);
    this.repoRoots.set(dir, { at: now, root });
    return root;
  }

  private async index(root: string): Promise<Set<string> | null> {
    const hit = this.indexes.get(root);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.files;
    const files = await readGitIndex(root);
    this.indexes.set(root, { at: now, files });
    return files;
  }

  private indexSync(root: string): Set<string> | null {
    const hit = this.indexes.get(root);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.files;
    const files = readGitIndexSync(root);
    this.indexes.set(root, { at: now, files });
    return files;
  }

  /**
   * 是否属于交付物。返回 null = 索引不可判定（不在任何版本库里），
   * 调用方必须按「不可判定」处理（保持原告警强度），不能当成 false。
   */
  async isTracked(fullPath: string): Promise<boolean | null> {
    const repo = this.resolveRepoFor(fullPath);
    if (repo === null) return null;
    const files = await this.index(repo);
    if (!files) return null;
    return hasTrackedUnder(files, repo, fullPath);
  }

  /** 同步版本（启动期一次性收敛用，避免把 async 传染进纯判据函数） */
  isTrackedSync(fullPath: string): boolean | null {
    const repo = this.resolveRepoFor(fullPath);
    if (repo === null) return null;
    const files = this.indexSync(repo);
    if (!files) return null;
    return hasTrackedUnder(files, repo, fullPath);
  }

  /** 清空缓存（监控停止时调用，避免进程常驻期间持有陈旧索引） */
  clear(): void {
    this.indexes.clear();
    this.repoRoots.clear();
  }
}

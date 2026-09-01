/**
 * Profile worker 线程入口（profile-worker.ts）
 *
 * 在独立 worker_threads 线程中执行项目画像 / 文件扫描类文件系统工作，
 * 避免 Electron 主进程（CrBrowserMain）被同步扫盘阻塞，导致 macOS 彩球。
 *
 * 协议（与 profile-host.ts 配对）：
 *   入站  { id, type, projectPath, options? }
 *   出站  { id, ok: true, result } | { id, ok: false, error }
 *
 * 职责：collectFiles（目录盘点）/ detectProfile（@zh/pipeline 项目画像）/
 *       runProfile（@zh/fingerprint 完整画像 + 问题集 + 漂移）/
 *       collectExposedFiles（技术债对外接口扫描）。
 */
import { parentPort, type MessagePort } from 'node:worker_threads';
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join, extname } from 'node:path';

const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx)$/;

interface ProfileWorkerOptions {
  excludeDirs?: string[];
  includeExtensions?: string[];
}

interface ProfileResult {
  files: Array<{ path: string; size: number; ext: string }>;
  stats: {
    totalFiles: number;
    totalSize: number;
    byExtension: Record<string, number>;
  };
}

/** 入站请求（id 由主进程生成，响应原样回传用于关联） */
export interface ProfileWorkerRequest {
  id: string;
  type: 'collectFiles' | 'detectProfile' | 'runProfile' | 'collectExposedFiles' | 'profileSync';
  projectPath: string;
  options?: ProfileWorkerOptions;
}

/** 出站响应（result 恒为可结构化克隆的纯 JSON） */
export type ProfileWorkerResponse =
  { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

/** 收集单个源码文件条目（扩展名匹配 + 大小统计；不可读文件跳过） */
function collectFileEntry(
  fullPath: string,
  name: string,
  includeExtensions: string[],
  files: ProfileResult['files'],
  byExtension: Record<string, number>,
  state: { totalSize: number },
): void {
  const ext = extname(name).toLowerCase();
  if (!includeExtensions.includes(ext)) return;
  try {
    const stat = statSync(fullPath);
    files.push({ path: fullPath, size: stat.size, ext });
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    state.totalSize += stat.size;
  } catch {
    /* skip unreadable files */
  }
}

function walkProjectFiles(
  dir: string,
  excludeDirs: string[],
  includeExtensions: string[],
  files: ProfileResult['files'],
  byExtension: Record<string, number>,
  state: { totalSize: number },
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    /* skip unreadable directories */ return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (excludeDirs.includes(entry.name)) continue;
      walkProjectFiles(fullPath, excludeDirs, includeExtensions, files, byExtension, state);
    } else if (entry.isFile()) {
      collectFileEntry(fullPath, entry.name, includeExtensions, files, byExtension, state);
    }
  }
}

/**
 * Worker thread for project profiling
 * Moves heavy filesystem operations off the main Electron thread
 */
function collectProjectFiles(projectPath: string, options?: ProfileWorkerOptions): ProfileResult {
  const excludeDirs = options?.excludeDirs ?? [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '__pycache__',
    '.venv',
    'vendor',
    '.cache',
  ];
  const includeExtensions = options?.includeExtensions ?? [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.rs',
    '.java',
    '.kt',
    '.vue',
    '.svelte',
    '.astro',
  ];

  const files: ProfileResult['files'] = [];
  const byExtension: Record<string, number> = {};
  const state = { totalSize: 0 };

  walkProjectFiles(projectPath, excludeDirs, includeExtensions, files, byExtension, state);

  return {
    files,
    stats: {
      totalFiles: files.length,
      totalSize: state.totalSize,
      byExtension,
    },
  };
}

/** 递归收集目录下常见源码文件（相对项目根的 posix 路径）；逻辑与原 engines.ts 主线程版逐行一致 */
function collectFilesRecursively(absDir: string, relPrefix: string, acc: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collectFilesRecursively(join(absDir, entry.name), rel, acc);
    } else if (SOURCE_FILE_RE.test(entry.name)) {
      acc.push(rel);
    }
  }
}

/** 扫描项目对外接口入口（API 路由/控制器/服务入口文件），目录缺失或不可读 → 跳过 */
function collectExposedFiles(projectPath: string): string[] {
  const exposed: string[] = [];
  const dirs = [
    'src/api',
    'src/routes',
    'src/controllers',
    'src/rest',
    'api',
    'routes',
    'controllers',
  ];
  for (const dir of dirs) {
    const abs = join(projectPath, dir);
    try {
      if (statSync(abs).isDirectory()) {
        collectFilesRecursively(abs, dir, exposed);
      }
    } catch {
      // 目录不可读时跳过
    }
  }
  const entryFiles = [
    'src/main.ts',
    'src/app.ts',
    'src/server.ts',
    'src/index.ts',
    'main.ts',
    'app.ts',
    'server.ts',
    'index.ts',
  ];
  for (const file of entryFiles) {
    try {
      statSync(join(projectPath, file));
      exposed.push(file);
    } catch {
      // 忽略 stat 失败
    }
  }
  return [...new Set(exposed)];
}

/** @zh/pipeline 项目画像识别（同步 fs，现移入 worker 执行） */
async function detectProjectProfileInWorker(projectPath: string): Promise<unknown> {
  const { detectProjectProfile } = await import('@zh/pipeline');
  return detectProjectProfile(projectPath);
}

/** @zh/fingerprint 完整画像流程：探测 + 落盘 + 问题集 + 漂移 */
async function runFingerprintProfile(projectPath: string): Promise<unknown> {
  const { profileProject } = await import('@zh/fingerprint');
  const result = await profileProject(projectPath);
  return { profile: result.profile, questions: result.questions, drift: result.drift };
}

/** @zh/fingerprint 同步画像（ScoringProjectProfile + warnings，原主进程同步调用，移入 worker） */
async function runSyncProfile(projectPath: string): Promise<unknown> {
  const { profileSync } = await import('@zh/fingerprint');
  return profileSync(projectPath);
}

async function dispatchRequest(req: ProfileWorkerRequest): Promise<unknown> {
  switch (req.type) {
    case 'collectFiles':
      return collectProjectFiles(req.projectPath, req.options);
    case 'detectProfile':
      return detectProjectProfileInWorker(req.projectPath);
    case 'runProfile':
      return runFingerprintProfile(req.projectPath);
    case 'collectExposedFiles':
      return collectExposedFiles(req.projectPath);
    case 'profileSync':
      return runSyncProfile(req.projectPath);
    default: {
      const exhaustive: never = req.type;
      throw new Error(`[profile-worker] 未知请求类型: ${String(exhaustive)}`);
    }
  }
}

function attachMessageHandler(port: MessagePort): void {
  port.on('message', (raw: ProfileWorkerRequest) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return;
    void dispatchRequest(raw)
      .then((result) => {
        const res: ProfileWorkerResponse = { id: raw.id, ok: true, result };
        port.postMessage(res);
      })
      .catch((err: unknown) => {
        const res: ProfileWorkerResponse = {
          id: raw.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        port.postMessage(res);
      });
  });
}

const port = parentPort;
if (port) {
  attachMessageHandler(port);
} else {
  throw new Error('[profile-worker] 必须以 worker_threads 方式启动（缺少 parentPort）');
}

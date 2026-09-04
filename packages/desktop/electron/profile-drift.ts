/**
 * 画像漂移监听（profile-drift.ts）
 *
 * T1 免维护同步的本地触发源：监听已注册项目根目录的依赖清单文件变化
 * （package.json / lock 文件 / pyproject.toml / go.mod 等，均为根目录文件，
 * 不递归监听 node_modules），防抖后重新探测画像。
 *
 * 探测结果画像与漂移前不同 → 重新按需同步工具规则（syncToolRulesForProfile，
 * 内含 /resolve/tools 裁剪）+ 云端规则对账（reconcileRulesWithCloud）。
 * 画像未变 → 不做任何事，避免无谓的网络与扫盘开销。
 */

import * as fs from 'node:fs';
import { readFile } from 'node:fs/promises';

import { PROJECTS_FILE } from './ipc/projects';
import { runProfileInWorker } from './profile-host';
import { getCachedProfile } from './ipc-context';
import { cacheProfileFromFingerprintResult } from './ipc/engines';
import { syncToolRulesForProfile } from './ipc/sync';
import { reconcileRulesWithCloud } from './ipc/resolve-reconcile';

/** 触发画像重探的依赖清单文件名（仅监听项目根目录，规避 node_modules 噪音） */
const WATCHED_MANIFESTS = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'poetry.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
]);

/** 防抖窗口：编辑器保存 / 包管理器批量写入会触发多次事件 */
const DEBOUNCE_MS = 15_000;
/** 项目清单扫描间隔：启动后与保存项目列表后各扫一次，避免常驻轮询 */
const REWATCH_DELAY_MS = 5_000;

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let watchers: fs.FSWatcher[] = [];
let started = false;

function scheduleReprobe(projectPath: string): void {
  const existing = debounceTimers.get(projectPath);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    debounceTimers.delete(projectPath);
    void reprobeProject(projectPath);
  }, DEBOUNCE_MS);
  timer.unref?.();
  debounceTimers.set(projectPath, timer);
}

/** 重探画像 → 画像漂移时重新按需同步（探测/同步失败仅 log，永不阻断） */
async function reprobeProject(projectPath: string): Promise<void> {
  try {
    const before = JSON.stringify(getCachedProfile());
    const result = await runProfileInWorker(projectPath);
    // 复用 onboarding 同款缓存逻辑：写画像缓存 + T0 云端注册
    cacheProfileFromFingerprintResult(result, projectPath);
    const after = JSON.stringify(getCachedProfile());
    if (before === after) return; // 画像未漂移：无需重新解析
    console.log(`[profile-drift] 画像漂移 → 重新按需同步 (${projectPath})`);
    await syncToolRulesForProfile();
    await reconcileRulesWithCloud();
  } catch (err) {
    console.warn(
      '[profile-drift] 画像重探失败（保持现有画像）:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

function watchProjectRoot(projectPath: string): void {
  try {
    const watcher = fs.watch(projectPath, (eventType, filename) => {
      if (!filename || !WATCHED_MANIFESTS.has(filename)) return;
      scheduleReprobe(projectPath);
    });
    watcher.on('error', () => {
      // 目录被移动/删除：静默失效，下轮重扫恢复
      watcher.close();
    });
    watchers.push(watcher);
  } catch {
    // 项目目录不可监听（权限/不存在）：跳过
  }
}

function closeWatchers(): void {
  for (const w of watchers) {
    try {
      w.close();
    } catch {
      // ignore
    }
  }
  watchers = [];
}

async function watchAllProjects(): Promise<void> {
  closeWatchers();
  let projects: Array<{ path: string }> = [];
  try {
    projects = JSON.parse(await readFile(PROJECTS_FILE, 'utf-8')) as Array<{ path: string }>;
  } catch {
    return; // 无项目列表（ENOENT 等）
  }
  for (const project of projects) {
    if (!project?.path) continue;
    // 目录存在性用异步 stat（主进程禁同步 fs；watch 本身对不存在目录会抛错被 catch 吞掉）
    try {
      const stat = await fs.promises.stat(project.path);
      if (stat.isDirectory()) watchProjectRoot(project.path);
    } catch {
      // 项目目录不存在：跳过
    }
  }
}

/**
 * 启动画像漂移监听。幂等：重复调用是 no-op。
 * 监听项目根目录的依赖清单文件；保存项目列表 5s 后重扫（新加项目纳入监听）。
 */
export function startProfileDriftWatcher(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    void watchAllProjects();
  }, REWATCH_DELAY_MS).unref?.();
}

/** 停止监听（测试 / 退出清理用） */
export function stopProfileDriftWatcher(): void {
  started = false;
  closeWatchers();
  for (const timer of debounceTimers.values()) clearTimeout(timer);
  debounceTimers.clear();
}

/** 供保存项目列表后主动纳入监听（避免等 5s 重扫） */
export function rewatchProjectsAfterChange(): void {
  if (!started) return;
  setTimeout(() => {
    void watchAllProjects();
  }, 1_000).unref?.();
}

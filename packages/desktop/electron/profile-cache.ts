/**
 * 当前项目画像缓存（profile-cache.ts）
 *
 * R3d 执行面投影激活所需的画像内存快照。由 engines.ts 在流水线完成 /
 * getProfile 后写入，sync.ts 读取用于按画像裁剪工具子集，pipeline-worker
 * 子进程读取用于按画像裁剪直扫。
 *
 * 本模块为纯内存状态 + 类型定义，不 import ipc-context / electron
 * （与 capability-refs 同一原则）：
 * - pipeline-worker 以 child_process.fork(ELECTRON_RUN_AS_NODE=1) 启动，
 *   子进程 require('electron') 为空对象，app.isPackaged 等访问即崩溃。
 * - ipc-context 顶层有大量 electron 副作用（app.getPath、app.isPackaged、
 *   SopCacheManager/WisdomBrainSync 单例），worker 构建绝不能内联它。
 * - 本模块导出与 ipc-context 原状态完全同构；ipc-context re-export 保持
 *   主进程既有导入路径不变，pipeline-jobs 直连本模块切断 worker 依赖链。
 */

/** 结构兼容 kernel ProjectFeature；null = 未探测（同步退化为全量下发，行为不变）。 */
export type CachedProjectFeature = {
  framework?: string;
  language?: string;
  features: string[];
};

let cachedProfile: CachedProjectFeature | null = null;
/** 与 cachedProfile 配套记录其归属项目路径；null = 未归属（单例/未探测） */
let cachedProfileProjectPath: string | null = null;

export function getCachedProfile(): CachedProjectFeature | null {
  return cachedProfile;
}

/**
 * 写入画像缓存；可选记录归属项目路径（供删项目时精确归还内存缓存）。
 * 向后兼容：不传 projectPath 时保持既有 path 不变；传 null 时清空 path。
 */
export function setCachedProfile(
  feature: CachedProjectFeature | null,
  projectPath?: string | null,
): void {
  cachedProfile = feature;
  if (projectPath !== undefined) {
    cachedProfileProjectPath = projectPath;
  }
}

/** 返回当前画像缓存归属的项目路径（null = 未归属） */
export function getCachedProfileProjectPath(): string | null {
  return cachedProfileProjectPath;
}
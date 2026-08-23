// @zh/profiler — 项目画像探测器
// 零运行时依赖，纯本地 fs 读取，可被任何 @zh 包 type-only 引用
export const VERSION = '0.1.0';

export { ProjectProfiler, profiler } from './profiler';
export { scanProject, readConfig, hasFile, countByExtension } from './file-scanner';
export type { ScanResult, ScanOptions } from './file-scanner';

export {
  detectLanguage,
  detectFramework,
  detectProjectType,
  detectPackageManager,
  detectRuntime,
} from './detectors';

export type {
  ProjectLanguage,
  ProjectFramework,
  ProjectType,
  PackageManager,
  Runtime,
  ProfileSignal,
  ModuleProfile,
  ProjectProfile,
  ProfileResult,
} from './types';

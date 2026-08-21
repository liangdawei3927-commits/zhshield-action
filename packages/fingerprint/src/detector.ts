// Detector 插件接口（架构文档 §6.1）+ 探测器注册表 + 扫描目录跳过集合。

import type { Signal, SignalKind } from './types';

/** 内置探测器 ID（探测层注册表；新增探测器 = 追加一项）。 */
export const DETECTOR_IDS = [
  'manifest-detector',
  'config-detector',
  'ext-stat-detector',
  'content-detector',
  'form-detector',
  'lockfile-detector',
] as const;

export type DetectorId = (typeof DETECTOR_IDS)[number];

/**
 * 递归扫描时必须跳过的目录（vendored / generated / 依赖产物 / 构建输出），任何层级生效。
 * §10.1 对抗用例约束：vendored、node_modules、dist 等噪声目录不得污染扩展名统计。
 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  'build',
  'coverage',
  '.next',
  '.turbo',
  'out',
  '.cache',
  '.idea',
  '.vscode',
  'target',
  '.gradle',
  '.mypy_cache',
  '.pytest_cache',
  '.opencode',
  '.zhshield',
  'SOP标准资源',
]);

/**
 * 探测插件。采集可并行（架构文档 §6.4 / C10：form-detector 只采集形态特征文件存在性原始信号，
 * 形态语义判定交给 Profiler 第二阶段）。
 */
export interface Detector {
  /** 'manifest-detector' | 'config-detector' | 'ext-stat-detector' | 'content-detector' | 'form-detector' | 'lockfile-detector' */
  readonly id: DetectorId;
  /** 声明产出信号类型 */
  readonly signalKinds: readonly SignalKind[];
  /** 权重：manifest=1.0, config=0.8, ext-stat=0.6, content=0.4（form/lockfile 语义判定在 Profiler，权重仅用于排序） */
  readonly weight: number;
  /** 对项目根路径执行探测，返回原始信号。 */
  detect(projectPath: string): Promise<Signal[]>;
}

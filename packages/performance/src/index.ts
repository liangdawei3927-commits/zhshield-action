// @zh/performance - 前端性能引擎（静态优先骨架）
export const VERSION = '0.1.0';

export { PerformanceEngine } from './engine';
export { DEFAULT_CONFIG } from './types';

export { BuildConfigDetectorImpl } from './adapters/build-config-detector';
export type { BuildConfigDetector } from './adapters/build-config-detector';
export { BundleSizeDetectorImpl } from './adapters/bundle-size-detector';
export type { BundleSizeDetector } from './adapters/bundle-size-detector';
export { TreeShakingDetectorImpl } from './adapters/tree-shaking-detector';
export type { TreeShakingDetector } from './adapters/tree-shaking-detector';

export type {
  PerformanceIssue,
  PerformanceReport,
  PerformanceConfig,
  PerformanceSeverity,
  PerformanceCategory,
} from './types';

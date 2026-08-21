/**
 * 前端性能静态分析 —— 数据模型（packages/performance）
 *
 * 静态优先骨架（路线图 §3.4 决策 2026-08-15）：
 * - 只做纯静态分析（包体积 / 构建配置 / tree-shaking / chunk 划分），
 *   绝不执行项目代码 —— 与 P0-2「扫描中绝不执行项目代码」禁令一致。
 * - 输出结构对齐桌面端 PerformanceReportData（serializable），
 *   便于 IPC / 诊断落盘 / 报告复用。
 */

/** 性能问题严重度（与桌面端 SEVERITY_CONFIG 键对齐） */
export type PerformanceSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/** 性能问题归属类别（性能域四个静态分析维度） */
export type PerformanceCategory =
  | 'bundle-size' // 包体积：产物体积 / 单文件过大 / 未压缩
  | 'build-config' // 构建配置：缺压缩 / 缺拆包 / 未开启产物优化
  | 'tree-shaking' // tree-shaking：sideEffects 缺失 / 全量引入大包
  | 'chunk-splitting'; // chunk 划分：单一 vendor chunk / 缺少代码分割

/** 单条性能问题（可解释，含修复建议） */
export interface PerformanceIssue {
  id: string;
  ruleId: string;
  /** 归属类别 */
  category: PerformanceCategory;
  severity: PerformanceSeverity;
  /** 相关文件（配置或产物路径，相对于项目根；无单文件时可留空） */
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
  autoFixable: boolean;
}

/** 性能检测报告（serializable，对齐桌面端 PerformanceReportData） */
export interface PerformanceReport {
  summary: {
    total: number;
    autoFixable: number;
    /** 各类别命中数（便于 UI 分维度展示） */
    byCategory: Partial<Record<PerformanceCategory, number>>;
  };
  issues: PerformanceIssue[];
  metadata: {
    duration: number;
    timestamp: string;
  };
}

/** 性能引擎配置 */
export interface PerformanceConfig {
  /** 单文件体积告警阈值（字节，默认 500KB） */
  largeFileThresholdBytes: number;
  /** vendor/产物目录内单 chunk 告警阈值（字节，默认 1MB） */
  largeChunkThresholdBytes: number;
  /** 是否分析产物目录（dist/build/out，默认 true；无产物时静默跳过） */
  analyzeArtifacts: boolean;
  /** 扫描文件数上限（防 DoS，默认 2000） */
  scanLimit: number;
}

export const DEFAULT_CONFIG: PerformanceConfig = {
  largeFileThresholdBytes: 500 * 1024,
  largeChunkThresholdBytes: 1024 * 1024,
  analyzeArtifacts: true,
  scanLimit: 2000,
};

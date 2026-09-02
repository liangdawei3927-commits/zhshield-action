/**
 * @zh/autoperf — 性能自治引擎数据模型
 *
 * 输入 = 基准运行数据 + 静态分析结果；输出 = Issue[]（复用 @zh/shared 的 Issue 模型：
 * ruleId / severity / fingerprint），走现成的门禁→修复→验证闭环，不新造流水线。
 *
 * 性能预算（PerfBudget）与 SOP 规则同构（flat form）：name/description/severity/
 * executionMode/status/source/tags/applicableEngines + content.values 数组。
 */

import type { Issue } from '@zh/shared';

/** 单条性能探测结果（基准运行数据） */
export interface PerfProbeResult {
  /** 探测名（如 coldScan / eventLoopDelay / memoryPeak / sentinelCpu） */
  probeName: string;
  /**
   * 探测数值。字段名沿用 elapsedMs（毫秒），但单位随探测类型：
   * 耗时类 = ms；sentinelCpu = 百分比（0-100，estimate）；memoryPeak = MB。
   * 单位约定与 assets/perf-budgets.yaml 头注一致；Issue 文案单位由引擎 PROBE_UNIT 决定。
   */
  elapsedMs: number;
  /** 采样时间戳 */
  sampledAt: Date;
  /** 附加元数据（如 sentinelCpu 的 estimate 标记、memoryPeak 的字节数） */
  metadata?: Record<string, unknown>;
}

/** 性能预算（即规则）：超预算 → Issue */
export interface PerfBudget {
  /** 规则 ID（如 perf.budget.cold-start） */
  ruleId: string;
  /** 预算名（如 冷启动） */
  name: string;
  /**
   * 阈值。单位随预算类型（有意复用同一字段，约定见 assets/perf-budgets.yaml 头注）：
   * 耗时类 = ms；perf.budget.sentinel-idle-cpu = 百分比；perf.budget.memory-peak = MB。
   */
  thresholdMs: number;
  /** 基线值（首次/参考测量值，用于随版本自动校准；单位约定同 thresholdMs） */
  anchorMs?: number;
  /** 超预算严重级（Issue 层：error | warning） */
  severity: 'error' | 'warning';
  /** 预算描述 */
  description: string;
}

/** 性能自治引擎报告 */
export interface AutoPerfReport {
  /** 探测结果 */
  probes: PerfProbeResult[];
  /** 评估出的问题（复用 Issue 模型） */
  issues: Issue[];
}

/** 复用 @zh/shared 的 Issue 模型（避免重复定义） */
export type { Issue, IssueSeverity } from '@zh/shared';

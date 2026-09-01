/**
 * 性能预算加载器 — 解析与 SOP 规则同构的 YAML（flat form），
 * 输出 PerfBudget[]。文件缺失 / 解析失败 → 返回内置默认预算。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { PerfBudget } from './types';

/** 内置默认预算（与 assets/perf-budgets.yaml 一致，作为兜底） */
export const DEFAULT_BUDGETS: PerfBudget[] = [
  {
    ruleId: 'perf.budget.cold-start',
    name: '冷启动',
    thresholdMs: 5000,
    severity: 'error',
    description: '应用冷启动耗时预算，超过 5000ms 视为性能退化',
  },
  {
    ruleId: 'perf.budget.scan-thousand-files',
    name: '千文件扫描',
    thresholdMs: 30000,
    severity: 'warning',
    description: '千文件规模扫描耗时预算，超过 30000ms 视为扫描性能退化',
  },
  {
    ruleId: 'perf.budget.event-loop-delay',
    name: '事件循环延迟',
    thresholdMs: 16,
    severity: 'warning',
    description: '主进程事件循环延迟预算，超过 16ms 视为阻塞',
  },
  {
    ruleId: 'perf.budget.sentinel-idle-cpu',
    name: '哨兵空闲 CPU',
    thresholdMs: 2,
    severity: 'warning',
    description: '哨兵空闲态 CPU 占用预算，超过 2% 视为异常（estimate）',
  },
  {
    ruleId: 'perf.budget.memory-peak',
    name: '内存峰值',
    thresholdMs: 4096,
    severity: 'error',
    description: '进程内存峰值预算，超过 4096MB (4GB) 视为内存异常',
  },
];

interface RawBudgetConfig {
  ruleId?: string;
  thresholdMs?: number;
  severity?: 'error' | 'warning';
  anchorMs?: number;
}

interface RawBudgetEntry {
  name?: string;
  description?: string;
  severity?: 'error' | 'warning';
  content?: { check?: { tool?: string; budgetConfig?: RawBudgetConfig } };
}

/** 默认预算文件路径（packages/autoperf/assets/perf-budgets.yaml） */
export function defaultBudgetFilePath(): string {
  return path.resolve(__dirname, '..', 'assets', 'perf-budgets.yaml');
}

/**
 * 加载性能预算。filePath 缺省时读取默认预算文件；文件缺失或解析失败 → 返回内置默认预算。
 */
export function loadPerfBudgets(filePath?: string): PerfBudget[] {
  const target = filePath ?? defaultBudgetFilePath();
  if (!fs.existsSync(target)) return DEFAULT_BUDGETS;

  let raw: unknown;
  try {
    raw = yaml.load(fs.readFileSync(target, 'utf8'));
  } catch {
    return DEFAULT_BUDGETS;
  }

  if (!Array.isArray(raw)) return DEFAULT_BUDGETS;

  const budgets: PerfBudget[] = [];
  for (const entry of raw as RawBudgetEntry[]) {
    const config = entry?.content?.check?.budgetConfig;
    if (!config?.ruleId || typeof config.thresholdMs !== 'number') continue;
    budgets.push({
      ruleId: config.ruleId,
      name: entry.name ?? config.ruleId,
      thresholdMs: config.thresholdMs,
      anchorMs: typeof config.anchorMs === 'number' ? config.anchorMs : undefined,
      severity: config.severity ?? entry.severity ?? 'warning',
      description: entry.description ?? '',
    });
  }

  return budgets.length > 0 ? budgets : DEFAULT_BUDGETS;
}

/**
 * 预算随版本自动校准。
 *
 * 基于历史基准运行数据调整 thresholdMs —— 性能预算不是拍脑袋的固定值，而是
 * 随版本基线自动漂移。校准策略：
 * - 新 threshold = max(anchorMs, historicalMedian * 1.1)
 *   （取历史中位数上浮 10% 作为新预算，兼顾「不严苛到误报」与「不放宽到失效」）
 * - 保证下限：绝不低于 anchorMs（基线安全下限）
 * - 保证上限：绝不超过 anchorMs * 5（防止校准过度放宽）
 *
 * @param budgets 当前预算
 * @param historicalResults 历史基准探测结果（name = ruleId，elapsed = 实测毫秒）
 * @returns 校准后的新预算（无历史或无 anchorMs 的预算原样返回）
 */
export function calibrateBudgets(
  budgets: PerfBudget[],
  historicalResults: Array<{ name: string; elapsed: number }>,
): PerfBudget[] {
  return budgets.map((budget) => {
    const history = historicalResults.filter((r) => r.name === budget.ruleId);
    if (history.length === 0 || budget.anchorMs === undefined) return budget;

    const sorted = history.map((h) => h.elapsed).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const calibrated = Math.max(budget.anchorMs, median * 1.1);
    const capped = Math.min(calibrated, budget.anchorMs * 5);

    return { ...budget, thresholdMs: Math.round(capped) };
  });
}

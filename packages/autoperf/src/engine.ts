/**
 * AutoPerfEngine — 性能自治引擎
 *
 * 输入 = 基准运行数据（probes）+ 静态分析结果；输出 = Issue[]（复用 @zh/shared 的 Issue 模型）。
 * 走现成的门禁→修复→验证闭环，不新造流水线。
 *
 * 设计要点：
 * - evaluate(probes) 为纯函数（给定注入的 probe 结果即确定性输出），可脱离真实扫描单测；
 * - scan() 为集成包装：真实运行各探测后调用 evaluate；
 * - 依赖注入（detectMachineProfile / budgets）便于测试与替换。
 */
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import type { Issue } from '@zh/shared';
import { detectMachineProfile } from '@zh/shared';
import type { AutoPerfReport, PerfBudget, PerfProbeResult } from './types';
import { loadPerfBudgets } from './budgets';

/** probeName → 预算 ruleId 映射（evaluate 据此匹配） */
const PROBE_BUDGET_MAP: Record<string, string> = {
  coldScan: 'perf.budget.cold-start',
  scanThousandFiles: 'perf.budget.scan-thousand-files',
  eventLoopDelay: 'perf.budget.event-loop-delay',
  sentinelCpu: 'perf.budget.sentinel-idle-cpu',
  memoryPeak: 'perf.budget.memory-peak',
};

/** probeName → 消息单位（非时间类探测用百分比 / MB） */
const PROBE_UNIT: Record<string, string> = {
  coldScan: 'ms',
  scanThousandFiles: 'ms',
  eventLoopDelay: 'ms',
  sentinelCpu: '%',
  memoryPeak: 'MB',
};

export interface AutoPerfEngineDeps {
  detectMachineProfile?: typeof detectMachineProfile;
  budgets?: PerfBudget[];
}

export class AutoPerfEngine {
  private readonly detectMachineProfileFn: typeof detectMachineProfile;
  private readonly budgets: PerfBudget[];

  constructor(private deps?: AutoPerfEngineDeps) {
    this.detectMachineProfileFn = deps?.detectMachineProfile ?? detectMachineProfile;
    this.budgets = deps?.budgets ?? loadPerfBudgets();
  }

  /** 返回机器画像（CPU/内存/并发预算） */
  getMachineProfile() {
    return this.detectMachineProfileFn();
  }

  /**
   * 集成扫描：运行各性能探测并评估为 Issue。
   * warm=true 时跳过冷启动探测（视为已预热）。
   */
  async scan(options: { projectPath: string; warm?: boolean }): Promise<AutoPerfReport> {
    const probes: PerfProbeResult[] = [];
    if (!options.warm) {
      probes.push(this.probeColdScan(options.projectPath));
    }
    probes.push(await this.probeEventLoopDelay());
    probes.push(this.probeMemoryPeak());
    probes.push(this.probeSentinelCpu());
    const issues = this.evaluate(probes, { projectPath: options.projectPath });
    return { probes, issues };
  }

  /**
   * 纯评估：给定 probe 结果，对照预算输出 Issue。
   * 未超预算 → 无 issue；恰好等于阈值 → 无 issue；超预算 → error/warning issue。
   */
  evaluate(probes: PerfProbeResult[], options?: { projectPath?: string }): Issue[] {
    const file = options?.projectPath || '<runtime>';
    const issues: Issue[] = [];
    for (const budget of this.budgets) {
      const probe = probes.find((p) => PROBE_BUDGET_MAP[p.probeName] === budget.ruleId);
      if (!probe) continue;
      // 未超预算（含恰好等于阈值）→ 无 issue
      if (probe.elapsedMs <= budget.thresholdMs) continue;
      const overPct = Math.round(
        ((probe.elapsedMs - budget.thresholdMs) / budget.thresholdMs) * 100,
      );
      const unit = PROBE_UNIT[probe.probeName] ?? 'ms';
      issues.push({
        id: randomUUID(),
        ruleId: budget.ruleId,
        severity: budget.severity,
        category: 'performance',
        message: `「${budget.name}」超预算：实测 ${probe.elapsedMs}${unit}，预算 ${budget.thresholdMs}${unit}，超出 ${overPct}%`,
        file,
        autoFixable: false,
        source: 'performance',
        fingerprint: `${budget.ruleId}:${probe.probeName}`,
      });
    }
    return issues;
  }

  // ─── 探测实现 ─────────────────────────────────────────

  /** 冷启动：递归统计 .ts/.js 源文件数并测墙钟耗时；无文件则跳过 */
  private probeColdScan(projectPath: string): PerfProbeResult {
    const start = Date.now();
    let count = 0;
    if (fs.existsSync(projectPath)) {
      count = this.countSourceFiles(projectPath);
    }
    const elapsedMs = Date.now() - start;
    return {
      probeName: 'coldScan',
      elapsedMs,
      sampledAt: new Date(),
      metadata: { fileCount: count, skipped: count === 0 },
    };
  }

  private countSourceFiles(dir: string): number {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    let count = 0;
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        count += this.countSourceFiles(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        count += 1;
      }
    }
    return count;
  }

  /** 事件循环延迟：monitorEventLoopDelay 采样 ~200ms，取均值（histogram 单位为纳秒，转毫秒） */
  private async probeEventLoopDelay(): Promise<PerfProbeResult> {
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    histogram.enable();
    await new Promise((resolve) => setTimeout(resolve, 200));
    histogram.disable();
    const elapsedMs = (histogram.mean || 0) / 1e6;
    return {
      probeName: 'eventLoopDelay',
      elapsedMs,
      sampledAt: new Date(),
      metadata: { sampleMs: 200, p95: histogram.percentile(95) / 1e6 },
    };
  }

  /** 内存峰值：heapUsed + arrayBuffers（MB） */
  private probeMemoryPeak(): PerfProbeResult {
    const usage = process.memoryUsage();
    const heapUsedMb = usage.heapUsed / 1024 / 1024;
    const arrayBuffersMb = (usage.arrayBuffers ?? 0) / 1024 / 1024;
    return {
      probeName: 'memoryPeak',
      elapsedMs: Math.round(heapUsedMb + arrayBuffersMb),
      sampledAt: new Date(),
      metadata: {
        heapUsedMb: Math.round(heapUsedMb),
        arrayBuffersMb: Math.round(arrayBuffersMb),
      },
    };
  }

  /** 哨兵空闲 CPU：loadavg[0] / cores（estimate，非精确采样） */
  private probeSentinelCpu(): PerfProbeResult {
    const cores = os.cpus().length;
    const load = os.loadavg()[0];
    const cpuPct = cores > 0 ? (load / cores) * 100 : 0;
    return {
      probeName: 'sentinelCpu',
      elapsedMs: Math.round(cpuPct * 100) / 100,
      sampledAt: new Date(),
      metadata: { estimate: true, loadavg1: load, cores },
    };
  }
}

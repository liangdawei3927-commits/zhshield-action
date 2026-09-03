// MachineProfile — 机器画像：启动时探测 CPU/内存，导出各环节并发与内存预算。
// 低配机（≤8GB）自动降并发，避免 turbo/适配器/vitest 同机并行打满内存（SIGKILL/彩球）。
// 消费方：inspect 适配器并行度（P0-1）、turbo 并发、vitest workers（Phase 2 自适应）。

import * as os from 'node:os';

export interface MachineProfile {
  /** 逻辑核心数 */
  cores: number;
  /** 总内存 GB（保留两位小数） */
  totalMemGb: number;
  /** 当前可用内存 GB（保留两位小数，供运行时降级参考） */
  freeMemGb: number;
  /** 低配机型判定：总内存 ≤ 8GB */
  lowMemory: boolean;
  /** ToolAdapter 并行扫描上限：低配 2，否则 cores（封顶 4） */
  adapterParallelism: number;
  /** turbo 并发（concurrency）：低配 1，否则 cores（封顶 4） */
  turboConcurrency: number;
  /** vitest 最大 worker 数：低配 2，否则 cores-1（封顶 4，至少 1） */
  vitestMaxWorkers: number;
}

const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max);

/**
 * 探测当前机器并推导各环节并发预算。
 * 依据文档《智汇码盾AutoPerf自动化性能优化方案》P0-1/MachineProfile：
 * 4 核 8GB 机型 → turbo --concurrency=1 · 适配器并行度 2 · vitest maxWorkers=2。
 */
export function detectMachineProfile(): MachineProfile {
  const cores = os.cpus().length;
  const totalMemGb = os.totalmem() / 1024 ** 3;
  const freeMemGb = os.freemem() / 1024 ** 3;
  const lowMemory = totalMemGb <= 8;
  return {
    cores,
    totalMemGb: Math.round(totalMemGb * 100) / 100,
    freeMemGb: Math.round(freeMemGb * 100) / 100,
    lowMemory,
    adapterParallelism: lowMemory ? 2 : clamp(cores, 2, 4),
    turboConcurrency: lowMemory ? 1 : clamp(cores, 2, 4),
    vitestMaxWorkers: lowMemory ? 2 : clamp(cores - 1, 1, 4),
  };
}

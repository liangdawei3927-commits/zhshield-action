/**
 * AutoPerfToolAdapter — 将 AutoPerf 性能自治引擎接入现有 ToolAdapter 流水线。
 * 复用 @zh/shared 的 ToolAdapter / ToolResult / ToolScanOptions 接口，
 * 输出 Issue[]（source='performance'），走现成门禁→修复→验证闭环。
 */
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, AccessScope } from '@zh/shared';
import { AutoPerfEngine } from './engine';

const META: ToolMeta = {
  id: 'autoperf',
  name: 'AutoPerf 性能自治',
  category: 'inspect',
  priority: 'P2',
  installMode: 'builtin',
  description:
    '性能自治引擎：基准运行数据 + 静态分析 → 性能预算 Issue（冷启动 / 千文件扫描 / 事件循环延迟 / 哨兵空闲 CPU / 内存峰值）',
  cliCommand: '',
  homepage: '',
  license: 'MIT',
};

export class AutoPerfToolAdapter implements ToolAdapter {
  meta = META;

  /** F5：AutoPerf 仅读取源码文件做静态统计，不触碰依赖与构建产物 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    excludePaths: ['**/node_modules/**', '**/dist/**'],
  };

  private engine = new AutoPerfEngine();

  /** AutoPerf 为内置引擎，始终可用 */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const report = await this.engine.scan({ projectPath: options.projectPath });
    const coldScan = report.probes.find((p) => p.probeName === 'coldScan');
    const fileCount =
      typeof coldScan?.metadata?.fileCount === 'number' ? coldScan.metadata.fileCount : 0;

    // 经验库回写：fire-and-forget，不阻断扫描结果；evolve 不可用或无 Issue 时静默跳过。
    if (report.issues.length > 0) {
      this.writeBackExperience(options.projectPath, report).catch(() => {
        /* evolve 不可用时静默降级 */
      });
    }

    return {
      tool: 'autoperf',
      status: 'available',
      issues: report.issues,
      metadata: {
        version: '0.1.0',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount,
      },
    };
  }

  /** 异步经验库回写（动态 import 避免 evolve 未构建时加载耦合） */
  private async writeBackExperience(
    projectPath: string,
    report: Awaited<ReturnType<AutoPerfEngine['scan']>>,
  ): Promise<void> {
    const { recordPerfExperience } = await import('./evolve-hook');
    await recordPerfExperience(projectPath, report);
  }
}

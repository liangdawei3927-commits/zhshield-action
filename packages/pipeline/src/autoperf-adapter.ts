/**
 * AutoPerf 性能自治引擎适配器注册
 *
 * 从 PipelineRunner 拆出的独立模块：动态导入 + try/catch 安全降级。
 * 若 @zh/autoperf 未构建 / 导入失败，仅告警不阻断流水线（fail-soft）。
 * 经 InspectEngine.registerAdapter → useSopEngine 连线自动注入 SopRuleEngine（tool-dispatch）。
 */
import type { InspectEngine } from '@zh/inspect';

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function registerAutoPerfAdapter(inspectEngine: InspectEngine): Promise<void> {
  try {
    const { AutoPerfToolAdapter } = await import('@zh/autoperf');
    inspectEngine.registerAdapter(new AutoPerfToolAdapter());
  } catch (err) {
    console.warn(`[pipeline] AutoPerf 适配器注册失败，跳过（性能自治降级）: ${toMessage(err)}`);
  }
}

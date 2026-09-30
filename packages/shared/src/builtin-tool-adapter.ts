// ─── 内置工具适配器基类（消除各内置适配器间的 isAvailable / scan 样板块重复）───

import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions } from './types';

/**
 * 内置工具适配器基类。
 *
 * 内置（installMode: 'builtin'）适配器随产品分发、无需探测与安装，isAvailable 恒为 true。
 * 各内置适配器此前各自手写 `async isAvailable(): Promise<boolean> { return true; }`，
 * 并在 scan 结果里手工拼装 version/duration/timestamp/fileCount 元数据 —— 该样板块跨
 * guard / inspect / autoperf 重复。本基类把这两段收敛为单一实现，语义与手写块完全一致。
 */
export abstract class BuiltinToolAdapter implements ToolAdapter {
  abstract meta: ToolMeta;

  abstract scan(options: ToolScanOptions): Promise<ToolResult>;

  /** 内置适配器始终可用 */
  async isAvailable(): Promise<boolean> {
    return true;
  }

  /**
   * 构造统一的扫描元数据（version/duration/timestamp/fileCount）。
   * 与原各适配器手写块的字段与取值完全一致：version 缺省为空串。
   */
  protected buildToolMetadata(
    start: number,
    fileCount: number,
    version = '',
  ): ToolResult['metadata'] {
    return {
      version,
      duration: Date.now() - start,
      timestamp: new Date(),
      fileCount,
    };
  }
}
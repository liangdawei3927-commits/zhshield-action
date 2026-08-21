import { randomUUID } from 'node:crypto';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, ToolId } from '@zh/shared';
import type { Adapter, CheckConfig, CheckResult } from './types';

/**
 * 将 Guard 的旧 Adapter 接口包装为 ToolAdapter，
 * 使 SopRuleEngine 的 tool-dispatch 可以调用 guard 适配器。
 *
 * 桥接方式：
 *   1. scan() → 构造 CheckConfig → adapter.run() + normalize() → CheckResult
 *   2. CheckResult → ToolResult (含 Issue[])
 */
export class GuardToolAdapterWrapper implements ToolAdapter {
  meta: ToolMeta;
  private adapter: Adapter;

  constructor(adapterName: string, adapter: Adapter, metaOverride?: Partial<ToolMeta>) {
    this.adapter = adapter;
    this.meta = {
      id: adapterName as ToolId,
      name: metaOverride?.name ?? adapterName,
      category: 'guard',
      priority: 'P1',
      installMode: 'builtin',
      description: metaOverride?.description ?? `Guard: ${adapterName}`,
      cliCommand: metaOverride?.cliCommand ?? '',
      homepage: '',
      license: '',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const config = (options.config ?? {}) as Record<string, unknown>;
    const check = this.buildCheckConfig(config);

    try {
      const result = await this.runAdapter(options, check);
      return this.toToolResult(result, check.checkId, start);
    } catch (err: unknown) {
      return this.toErrorResult(err, start);
    }
  }

  private buildCheckConfig(config: Record<string, unknown>): CheckConfig {
    return {
      checkId: (config.ruleId as string) ?? `guard.${this.meta.id}`,
      adapter: this.meta.id,
      enabled: true,
      mode: ['guard'],
      category: 'guard',
      severity: (config.severity as CheckConfig['severity']) ?? 'error',
      blocking: true,
      description: (config.description as string) ?? '',
    };
  }

  private async runAdapter(options: ToolScanOptions, check: CheckConfig) {
    const raw = await Promise.resolve(
      this.adapter.run(
        {
          projectPath: options.projectPath,
          targetFiles: options.targetFiles,
        },
        check,
      ),
    );
    return this.adapter.normalize(raw, {}, check);
  }

  private toToolResult(result: CheckResult, checkId: string, start: number): ToolResult {
    const issues: Issue[] = [];

    if (result.status === 'failed' || result.status === 'error') {
      issues.push({
        id: randomUUID(),
        ruleId: checkId,
        severity: result.severity === 'error' ? 'error' : 'warning',
        category: 'quality',
        message: result.message,
        file: '',
        autoFixable: false,
        source: 'guard',
        fingerprint: `${checkId}:${result.message}`,
      });
    }

    return {
      tool: this.meta.id,
      status: result.status === 'error' ? 'error' : 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: 0,
      },
      error: result.status === 'error' ? result.message : undefined,
    };
  }

  private toErrorResult(err: unknown, start: number): ToolResult {
    return {
      tool: this.meta.id,
      status: 'error',
      issues: [],
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: 0,
      },
      error: err instanceof Error ? err.message : 'Guard adapter failed',
    };
  }
}

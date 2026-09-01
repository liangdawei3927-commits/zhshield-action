import type { InspectAdapter, AdapterResult, RunContext } from './types';

export class AdapterRunner {
  private adapters = new Map<string, InspectAdapter>();
  private timeoutMs: number;

  constructor(timeoutMs: number = 120_000) {
    this.timeoutMs = timeoutMs;
  }

  register(adapter: InspectAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async runAll(context: RunContext): Promise<AdapterResult[]> {
    const results: AdapterResult[] = [];
    for (const [id, adapter] of this.adapters) {
      const start = Date.now();
      try {
        const issues = await this.withTimeout(adapter.run(context), id);
        results.push({
          adapterId: id,
          adapterName: adapter.name,
          duration: Date.now() - start,
          issueCount: issues.length,
          passed: !issues.some((i) => i.severity === 'error'),
          issues,
        });
      } catch (error) {
        results.push({
          adapterId: id,
          adapterName: adapter.name,
          duration: Date.now() - start,
          issueCount: 1,
          passed: false,
          issues: [
            {
              id: `error-${id}`,
              ruleId: 'ADAPTER-ERROR',
              severity: 'error',
              category: 'quality',
              message: error instanceof Error ? error.message : String(error),
              file: '',
              autoFixable: false,
              source: id,
              fingerprint: `${id}-error`,
            },
          ],
        });
      }
    }
    return results;
  }

  /** 单适配器硬上限：与 ToolAdapterExecutor.withHardTimeout 同语义，超时即 reject 走 catch 降级 */
  private withTimeout<T>(promise: Promise<T>, adapterId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`[inspect] ${adapterId} 扫描超过 ${this.timeoutMs}ms 硬上限，已跳过`)),
        this.timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
}

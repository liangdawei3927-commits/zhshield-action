import type { InspectAdapter, AdapterResult, RunContext } from './types';

export class AdapterRunner {
  private adapters = new Map<string, InspectAdapter>();

  register(adapter: InspectAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  async runAll(context: RunContext): Promise<AdapterResult[]> {
    const results: AdapterResult[] = [];
    for (const [id, adapter] of this.adapters) {
      const start = Date.now();
      try {
        const issues = await adapter.run(context);
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
          issues: [{
            id: `error-${id}`,
            ruleId: 'ADAPTER-ERROR',
            severity: 'error',
            category: 'quality',
            message: error instanceof Error ? error.message : String(error),
            file: '',
            autoFixable: false,
            source: id,
            fingerprint: `${id}-error`,
          }],
        });
      }
    }
    return results;
  }
}

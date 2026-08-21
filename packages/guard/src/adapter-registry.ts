import type { Adapter } from './types';

export class AdapterRegistry {
  private adapters = new Map<string, Adapter>();

  register(name: string, adapter: Adapter): void {
    this.adapters.set(name, adapter);
  }

  get(name: string): Adapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(`adapter not found: ${name}`);
    }
    return adapter;
  }

  has(name: string): boolean {
    return this.adapters.has(name);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}

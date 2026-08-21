export interface Plugin {
  name: string;
  version: string;
  init?: () => Promise<void>;
  destroy?: () => Promise<void>;
}

export class PluginLoader {
  private plugins = new Map<string, Plugin>();

  async load(plugin: Plugin): Promise<void> {
    if (plugin.init) await plugin.init();
    this.plugins.set(plugin.name, plugin);
  }

  async unload(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (plugin?.destroy) await plugin.destroy();
    this.plugins.delete(name);
  }

  get<T extends Plugin = Plugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined;
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
  }

  async unloadAll(): Promise<void> {
    for (const [name] of this.plugins) {
      await this.unload(name);
    }
  }
}

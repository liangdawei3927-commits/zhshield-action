import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import type { ToolId, ToolAdapter, ToolVersionInfo } from './types';
import { probeToolVersion } from './tool-probe';

const VERSION_PATTERN = /(\d+\.\d+\.\d+[\w.-]*)/;

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export class ToolManager {
  private tools = new Map<ToolId, ToolAdapter>();
  private configPath: string;
  private recommendedVersions: Record<string, string> = {
    eslint: '8.57.0',
    semgrep: '1.78.0',
    trivy: '0.52.0',
    grype: '0.79.0',
    gitleaks: '8.18.0',
    ort: '23.0.0',
    depcheck: '0.9.1',
    'ts-prune': '0.1.0',
  };

  constructor(configPath?: string) {
    this.configPath = configPath || path.join(os.homedir(), '.zhshield', 'tool-versions.json');
    this.loadConfig().catch(() => {});
  }

  async loadConfig(): Promise<Record<string, string>> {
    try {
      const content = await fs.readFile(this.configPath, 'utf-8');
      const config: Record<string, string> = JSON.parse(content);
      for (const [tool, version] of Object.entries(config)) {
        if (typeof version === 'string') {
          this.recommendedVersions[tool] = version;
        }
      }
      return { ...this.recommendedVersions };
    } catch {
      return { ...this.recommendedVersions };
    }
  }

  async saveConfig(): Promise<void> {
    await this.writeVersions(this.configPath);
  }

  private async writeVersions(filePath: string): Promise<void> {
    await writeJsonFile(filePath, this.recommendedVersions);
  }

  register(tool: ToolAdapter): void {
    this.tools.set(tool.meta.id, tool);
  }

  get(id: ToolId): ToolAdapter {
    const tool = this.tools.get(id);
    if (!tool) {
      throw new Error(`Tool not registered: ${id}`);
    }
    return tool;
  }

  getAll(): ToolAdapter[] {
    return [...this.tools.values()];
  }

  async isAvailable(id: ToolId): Promise<boolean> {
    const tool = this.tools.get(id);
    if (!tool) return false;
    try {
      return await tool.isAvailable();
    } catch {
      return false;
    }
  }

  async getVersion(id: ToolId): Promise<string | null> {
    const tool = this.tools.get(id);
    if (!tool) return null;
    // 经 single-flight 探测：就绪面板与各引擎适配器探同一命令时只起一次进程（见 tool-probe.ts）
    const probe = await probeToolVersion(tool.meta.cliCommand, 5000);
    if (!probe.ok) return null;
    const match = probe.stdout.match(VERSION_PATTERN);
    // match[1] 在无捕获组命中时为 undefined，?? null 与函数返回契约 string | null 对齐
    return match ? (match[1] ?? null) : probe.stdout.trim().split('\n')[0] || null;
  }

  async checkAllAvailability(): Promise<Partial<Record<ToolId, boolean>>> {
    const results: Partial<Record<ToolId, boolean>> = {};
    const toolIds = [...this.tools.keys()];
    const checks = toolIds.map(async (id) => {
      results[id] = await this.isAvailable(id);
    });
    await Promise.all(checks);
    return results;
  }

  getRecommendedVersions(): Record<string, string> {
    return { ...this.recommendedVersions };
  }

  async verifyVersions(): Promise<ToolVersionInfo[]> {
    const results: ToolVersionInfo[] = [];
    for (const [id] of this.tools) {
      const installedVersion = await this.getVersion(id);
      const recommendedVersion = this.recommendedVersions[id] || 'latest';
      const tool = this.tools.get(id)!;
      results.push({
        tool: id,
        installedVersion,
        recommendedVersion,
        binaryPath: null,
      });
      void tool;
    }
    return results;
  }
}

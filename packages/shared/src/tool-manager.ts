import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import type { ToolId, ToolAdapter, ToolVersionInfo } from './types';
import { sanitizeEnv } from './process-env';
import { defaultToolLockfilePath, loadToolLockfile } from './toolchain/types';

const execFileAsync = promisify(execFile);

const VERSION_PATTERN = /(\d+\.\d+\.\d+[\w.-]*)/;

const BIN_DIR_ENV = 'ZH_TOOL_BIN_DIR';

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export class ToolManager {
  private tools = new Map<ToolId, ToolAdapter>();
  private configPath: string;
  private binDir: string;
  private lockfilePath: string;
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

  constructor(configPath?: string, binDir?: string, lockfilePath?: string) {
    this.configPath = configPath || path.join(os.homedir(), '.zhshield', 'tool-versions.json');
    this.binDir =
      binDir || process.env[BIN_DIR_ENV] || path.join(os.homedir(), '.zhshield', 'bin');
    this.lockfilePath = lockfilePath || defaultToolLockfilePath();
    this.loadConfig().catch(() => {});
  }

  getBinDir(): string {
    return this.binDir;
  }

  /** 固定托管目录（ZH_TOOL_BIN_DIR / ~/.zhshield/bin）优先，回退 PATH；未注册返回 null */
  async resolveBinary(id: ToolId): Promise<string | null> {
    const tool = this.tools.get(id);
    if (!tool) return null;

    if (this.binDir) {
      const managedPath = path.join(this.binDir, tool.meta.cliCommand || id);
      try {
        await fs.access(managedPath, fs.constants.X_OK);
        return managedPath;
      } catch {
        // 托管目录不存在该二进制，回退 PATH
      }
    }

    return tool.meta.cliCommand || id;
  }

  async loadConfig(): Promise<Record<string, string>> {
    // lockfile 是版本锁的权威来源（供应链锁 P0-4），覆盖硬编码默认
    const lockfile = await loadToolLockfile(this.lockfilePath);
    if (lockfile) {
      for (const [tool, record] of Object.entries(lockfile.tools)) {
        if (record?.version) {
          this.recommendedVersions[tool] = record.version;
        }
      }
    }
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
    const binary = await this.resolveBinary(id);
    if (!binary) return null;
    try {
      const { stdout } = await execFileAsync(binary, ['--version'], {
        timeout: 5000,
        env: sanitizeEnv(),
      });
      const match = stdout.match(VERSION_PATTERN);
      return match ? match[1] : stdout.trim().split('\n')[0] || null;
    } catch {
      return null;
    }
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
      const binaryPath = await this.resolveBinary(id);
      results.push({
        tool: id,
        installedVersion,
        recommendedVersion,
        binaryPath,
      });
    }
    return results;
  }
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { depcheckMapper } from '@zh/shared';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions } from '@zh/shared';
import type { ExecError, DepcheckOutput } from './tool-output-types';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'depcheck',
  name: 'Depcheck',
  category: 'security',
  priority: 'P1',
  installMode: 'builtin',
  description: '未使用依赖检测',
  cliCommand: 'depcheck',
  homepage: 'https://github.com/depcheck/depcheck',
  license: 'MIT',
};

export class DepcheckAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('depcheck', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();

    try {
      const output = await this.runDepcheck(options);
      const issues = depcheckMapper(output);

      return {
        tool: 'depcheck',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
      };
    } catch (error) {
      return this.buildErrorResult(start, error as ExecError);
    }
  }

  private async runDepcheck(options: ToolScanOptions): Promise<DepcheckOutput> {
    const { stdout } = await execFileAsync('depcheck', [options.projectPath, '--json'], {
      cwd: options.projectPath,
      timeout: options.timeout || 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  private buildErrorResult(start: number, err: ExecError): ToolResult {
    if (err.code === 'ENOENT') {
      return {
        tool: 'depcheck',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'depcheck 未安装',
      };
    }
    return {
      tool: 'depcheck',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'depcheck 执行失败',
    };
  }
}

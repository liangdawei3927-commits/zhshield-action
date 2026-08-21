import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';
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
      const { stdout } = await execFileAsync('depcheck', [
        options.projectPath,
        '--json',
      ], {
        cwd: options.projectPath,
        timeout: options.timeout || 30000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const output = JSON.parse(stdout);
      const issues = this.mapOutput(output);

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
      const err = error as ExecError;
      if (err.code === 'ENOENT') {
        return {
          tool: 'depcheck',
          status: 'unavailable',
          issues: [],
          metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
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

  private mapOutput(output: DepcheckOutput): Issue[] {
    if (!output || typeof output !== 'object') return [];
    const issues: Issue[] = [];
    const deps: string[] = output.dependencies || [];
    const devDeps: string[] = output.devDependencies || [];

    for (const name of deps) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dep',
        severity: 'info',
        category: 'quality',
        message: `未使用的生产依赖: ${name}`,
        file: 'package.json',
        line: 0,
        column: 0,
        suggestion: `移除 ${name} 从 dependencies`,
        autoFixable: false,
        source: 'security',
        fingerprint: `depcheck:${name}:dependencies`,
      });
    }
    for (const name of devDeps) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dev-dep',
        severity: 'info',
        category: 'quality',
        message: `未使用的开发依赖: ${name}`,
        file: 'package.json',
        line: 0,
        column: 0,
        suggestion: `移除 ${name} 从 devDependencies`,
        autoFixable: false,
        source: 'security',
        fingerprint: `depcheck:${name}:devDependencies`,
      });
    }
    return issues;
  }
}

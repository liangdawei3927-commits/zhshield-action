import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue } from '@zh/shared';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'ts-prune',
  name: 'ts-prune',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: 'TypeScript 死代码/未导出检测',
  cliCommand: 'ts-prune',
  homepage: 'https://github.com/nadeesha/ts-prune',
  license: 'MIT',
};

const TS_PRUNE_LINE = /^(.+?):(\d+):\s*(.+)$/;

export class TsPruneAdapter implements ToolAdapter {
  meta = META;

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('ts-prune', ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const tsConfigPath = path.join(options.projectPath, 'tsconfig.json');

    try {
      const { stdout } = await execFileAsync('ts-prune', [
        '-p', tsConfigPath,
        '--json',
      ], {
        cwd: options.projectPath,
        timeout: options.timeout || 60000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const issues = this.mapOutput(stdout);

      return {
        tool: 'ts-prune',
        status: 'available',
        issues,
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: issues.length,
        },
      };
    } catch (error: unknown) {
      const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') {
        return {
          tool: 'ts-prune',
          status: 'unavailable',
          issues: [],
          metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
          error: 'ts-prune 未安装',
        };
      }

      if (err.stdout) {
        const issues = this.mapOutput(err.stdout);
        if (issues.length > 0) {
          return {
            tool: 'ts-prune',
            status: 'available',
            issues,
            metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: issues.length },
          };
        }
      }

      return {
        tool: 'ts-prune',
        status: 'error',
        issues: [],
        metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
        error: err.stderr || err.message || 'ts-prune 执行失败',
      };
    }
  }

  private mapOutput(raw: string): Issue[] {
    if (!raw || !raw.trim()) return [];
    const lines = raw.trim().split('\n');
    const issues: Issue[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const match = trimmed.match(TS_PRUNE_LINE);
      if (match) {
        const [, filePath, lineStr, symbol] = match;
        issues.push({
          id: randomUUID(),
          ruleId: 'ts-prune/unused-export',
          severity: 'info',
          category: 'quality',
          message: `未使用的导出: ${symbol.trim()}`,
          file: filePath,
          line: parseInt(lineStr, 10) || 0,
          column: 0,
          suggestion: `移除未使用的导出符号: ${symbol.trim()}`,
          autoFixable: false,
          source: 'inspect',
          fingerprint: `ts-prune:${filePath}:${lineStr}:${symbol.trim()}`,
        });
      }
    }

    return issues;
  }
}

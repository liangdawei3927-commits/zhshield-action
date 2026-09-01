import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  AccessScope,
} from '@zh/shared';
import { resolveToolCommand } from './tool-bin';
import { isCommandAvailable } from './tool-available';

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
  private commandPromise?: Promise<string>;
  private readonly projectRoot?: string;

  /** F5：ts-prune 基于 tsconfig 分析 TS 源码的未导出符号 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx}', '**/tsconfig.json'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('ts-prune', this.projectRoot);
    }
    return this.commandPromise;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runTsPrune(options, start);
    } catch (error: unknown) {
      return this.handleTsPruneError(error, start);
    }
  }

  /** 执行 ts-prune 并映射输出为可用结果 */
  private async runTsPrune(options: ToolScanOptions, start: number): Promise<ToolResult> {
    const tsConfigPath = path.join(options.projectPath, 'tsconfig.json');
    const command = await this.resolveCommand();
    const { stdout } = await execFileAsync(command, ['-p', tsConfigPath, '--json'], {
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
  }

  /** 处理 ts-prune 执行错误：未安装 / 部分输出 / 失败 */
  private handleTsPruneError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'ts-prune',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
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
          metadata: {
            version: '',
            duration: Date.now() - start,
            timestamp: new Date(),
            fileCount: issues.length,
          },
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

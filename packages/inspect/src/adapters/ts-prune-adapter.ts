import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
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
    // ts-prune 的 `--version` 不短路：会连同参数当作项目扫描真实执行（实测输出为全量
    // 未导出报告而非版本号），>20s 超时 → isCommandAvailable 误判未安装。
    // 改为检查解析出的命令文件存在且可执行（解析链已覆盖本地 bin / PATH / zhshield bin）。
    try {
      const command = await this.resolveCommand();
      if (path.isAbsolute(command)) {
        await fs.promises.access(command, fs.constants.X_OK);
        return true;
      }
      // 裸命令名（PATH 上解析到）：逐 PATH 目录查找可执行文件，避免执行 --version
      const pathEnv = process.env.PATH ?? '';
      for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir) continue;
        try {
          await fs.promises.access(path.join(dir, command), fs.constants.X_OK);
          return true;
        } catch {
          // 该目录无此命令，继续下一个 PATH 目录
        }
      }
      return false;
    } catch {
      return false;
    }
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
    // ts-prune@0.10.3 runner 内部用 path.join(process.cwd(), tsConfigPath) 组装路径，
    // 传绝对路径会翻倍（cwd/projectPath + 绝对路径）；cwd 已是 projectPath，故传相对路径。
    const tsConfigAbsPath = path.resolve(options.projectPath, 'tsconfig.json');
    const tsConfigPath = path.relative(options.projectPath, tsConfigAbsPath);
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

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
import { isCommandAvailable } from './tool-available';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'depcheck',
  name: 'Depcheck',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: '未使用依赖检测',
  cliCommand: 'depcheck',
  homepage: 'https://github.com/depcheck/depcheck',
  license: 'MIT',
};

interface DepcheckResult {
  dependencies: string[];
  devDependencies: string[];
  missing: Record<string, string[]>;
  using: Record<string, string[]>;
}

export class DepcheckAdapter implements ToolAdapter {
  meta = META;
  /** 按锚点（projectRoot ?? projectPath）缓存解析结果；isAvailable 的无锚点 PATH 探测与 scan 的项目本地解析互不污染（09-12 复验修复） */
  private readonly commandCache = new Map<string, Promise<string>>();
  private readonly projectRoot?: string;

  /** F5：depcheck 读 package.json 并静态解析源码 import 判断未使用依赖 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/package.json', '**/*.{ts,tsx,js,jsx}'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(projectPath?: string): Promise<string> {
    // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：anchor = projectRoot ?? projectPath，
    // 无锚点时仅 PATH/共享目录探测（isAvailable 用），scan 时以 options.projectPath 锚定本地 bin。
    const anchor = this.projectRoot ?? projectPath;
    const key = anchor ?? '';
    let cached = this.commandCache.get(key);
    if (!cached) {
      cached = resolveToolCommand('depcheck', anchor);
      this.commandCache.set(key, cached);
    }
    return cached;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runDepcheck(options, start);
    } catch (error: unknown) {
      return this.handleDepcheckError(error, start);
    }
  }

  /** 执行 depcheck 并映射输出为可用结果 */
  private async runDepcheck(options: ToolScanOptions, start: number): Promise<ToolResult> {
    const projectPath = options.projectPath;
    const pkgJson = path.join(projectPath, 'package.json');
    try {
      await fs.promises.access(pkgJson);
    } catch {
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
        error: `目标目录无 package.json（${projectPath}），跳过未使用依赖检测`,
      };
    }
    const command = await this.resolveCommand(options.projectPath);
    const args = this.buildArgs(options, projectPath);

    let stdout = '';
    try {
      const res = await execFileAsync(command, args, {
        cwd: projectPath,
        timeout: options.timeout || 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = res.stdout;
    } catch (error) {
      // depcheck 检出未使用依赖时以非零码退出但 stdout 仍是合法 JSON（本项目实测 exit 255）
      const err = error as { stdout?: string };
      if (err.stdout) {
        stdout = err.stdout;
      } else {
        return this.handleDepcheckError(error, start);
      }
    }

    let result: DepcheckResult;
    try {
      result = JSON.parse(stdout);
    } catch {
      return {
        tool: 'depcheck',
        status: 'error',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'depcheck 输出不是合法 JSON',
      };
    }
    const issues = this.mapOutput(result, projectPath);

    return {
      tool: 'depcheck',
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

  /** 依据配置组装 depcheck 命令行参数 */
  private buildArgs(options: ToolScanOptions, projectPath: string): string[] {
    const args = [projectPath, '--json'];
    const cfg = options.config as Record<string, unknown> | undefined;
    if (cfg?.skip) {
      for (const s of cfg.skip as string[]) args.push('--skip', s);
    }
    if (cfg?.ignore) {
      for (const ig of cfg.ignore as string[]) args.push('--ignore', ig);
    }
    return args;
  }

  /** 处理 depcheck 执行错误：未安装 / 失败 */
  private handleDepcheckError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stderr?: string; message?: string };
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

  private mapOutput(result: DepcheckResult, projectPath: string): Issue[] {
    const issues: Issue[] = [];
    const relPkgJson =
      path.relative(projectPath, path.join(projectPath, 'package.json')) || 'package.json';

    for (const dep of result.dependencies || []) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dependency',
        severity: 'warning',
        category: 'dependency',
        message: `未使用的依赖: ${dep}`,
        file: relPkgJson,
        line: 0,
        column: 0,
        suggestion: `运行 npm uninstall ${dep} 移除未使用的依赖`,
        autoFixable: false,
        source: 'inspect',
        fingerprint: `depcheck:unused:${dep}`,
      });
    }

    for (const dep of result.devDependencies || []) {
      issues.push({
        id: randomUUID(),
        ruleId: 'depcheck/unused-dev-dependency',
        severity: 'info',
        category: 'dependency',
        message: `未使用的 dev 依赖: ${dep}`,
        file: relPkgJson,
        line: 0,
        column: 0,
        suggestion: `将 ${dep} 移入 dependencies 或运行 npm uninstall -D ${dep}`,
        autoFixable: false,
        source: 'inspect',
        fingerprint: `depcheck:unused-dev:${dep}`,
      });
    }

    return issues;
  }
}

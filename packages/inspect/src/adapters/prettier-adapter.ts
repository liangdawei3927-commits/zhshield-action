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

const META: Omit<ToolMeta, 'description'> = {
  id: 'prettier',
  name: 'Prettier',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  cliCommand: 'prettier',
  homepage: 'https://prettier.io',
  license: 'MIT',
};

/** prettier --list-different 以相对 cwd 的路径逐行列出格式不一致的文件 */
function parseListDifferent(raw: string, projectPath: string): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const rel = line.trim();
    if (!rel || rel.startsWith('[')) continue; // 跳过空行与汇总提示行
    const file = path.isAbsolute(rel) ? rel : path.join(projectPath, rel);
    if (seen.has(file)) continue;
    seen.add(file);
    issues.push({
      id: randomUUID(),
      ruleId: 'prettier/format',
      severity: 'warning',
      category: 'quality',
      message: `文件不符合 Prettier 格式规范: ${rel}`,
      file,
      suggestion: '运行 prettier --write 修复格式',
      autoFixable: true,
      source: 'inspect',
      fingerprint: `prettier:format:${file}`,
    });
  }
  return issues;
}

export class PrettierAdapter implements ToolAdapter {
  meta: ToolMeta;
  private commandPromise?: Promise<string>;
  private readonly projectRoot?: string;

  /** F5：prettier 对源码与配置文件做格式检查 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml,css,scss}'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
    this.meta = { ...META, description: '代码格式一致性检查（Prettier --list-different）' };
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('prettier', this.projectRoot);
    }
    return this.commandPromise;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runPrettierScan(options, start);
    } catch (error: unknown) {
      return this.handleError(error, start);
    }
  }

  private async runPrettierScan(options: ToolScanOptions, start: number): Promise<ToolResult> {
    const command = await this.resolveCommand();
    const target = options.targetFiles?.length
      ? options.targetFiles[0]
      : PrettierAdapter.pickScanTarget(options.projectPath);
    const args = ['--list-different', target];

    let stdout = '';
    try {
      ({ stdout } = await execFileAsync(command, args, {
        cwd: options.projectPath,
        timeout: options.timeout || 120000,
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (error: unknown) {
      // prettier 有格式问题时以退出码 1 结束并列出文件，属正常路径而非失败
      const err = error as { code?: number; stdout?: string };
      if (typeof err.code !== 'number' || err.code === 0) throw error;
      stdout = err.stdout ?? '';
    }

    const issues = parseListDifferent(stdout, options.projectPath);
    return {
      tool: 'prettier',
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

  /** 扫描目标：优先 src/，monorepo 回退项目根（交由 .prettierignore 约束范围） */
  static pickScanTarget(projectPath: string): string {
    return fs.existsSync(path.join(projectPath, 'src')) ? 'src' : '.';
  }

  private handleError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildResult(start, 'unavailable', [], 'prettier 未安装或未在 PATH 中找到');
    }
    return this.buildResult(start, 'error', [], err.stderr || err.message || 'prettier 执行失败');
  }

  private buildResult(
    start: number,
    status: 'available' | 'unavailable' | 'error',
    issues: Issue[],
    error?: string,
  ): ToolResult {
    return {
      tool: 'prettier',
      status,
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: issues.length,
      },
      ...(error ? { error } : {}),
    };
  }
}

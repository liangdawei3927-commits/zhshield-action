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
import { resolveInjectedConfigPath } from './injected-config';

const execFileAsync = promisify(execFile);

const META: ToolMeta = {
  id: 'dep-cruiser',
  name: 'Dependency Cruiser',
  category: 'inspect',
  priority: 'P1',
  installMode: 'builtin',
  description: '架构边界与模块依赖检查',
  cliCommand: 'depcruise',
  homepage: 'https://github.com/sverweij/dependency-cruiser',
  license: 'MIT',
};

/** Dependency-cruiser JSON 输出中的单条违规 */
interface DepCruiserViolation {
  rule?: { name?: string; severity?: string };
  from?: { path?: string; line?: number };
  to?: { path?: string };
}

/** Dependency-cruiser JSON 输出结构 */
interface DepCruiserOutput {
  summary?: { violations?: DepCruiserViolation[] };
}

export class DependencyCruiserAdapter implements ToolAdapter {
  meta = META;
  private commandPromise?: Promise<string>;
  private readonly projectRoot?: string;

  /** F5：dep-cruiser 校验 src/ 目录内模块依赖边界 */
  readonly accessScope: AccessScope = {
    readPaths: ['src/**', 'package.json'],
    excludePaths: ['**/node_modules/**'],
  };

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
  }

  private resolveCommand(): Promise<string> {
    if (!this.commandPromise) {
      this.commandPromise = resolveToolCommand('depcruise', this.projectRoot);
    }
    return this.commandPromise;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    try {
      return await this.runDepCruiser(options, start);
    } catch (error: unknown) {
      return this.handleDepCruiserError(error, start);
    }
  }

  /** 执行 dependency-cruiser 并映射输出为可用结果 */
  private async runDepCruiser(options: ToolScanOptions, start: number): Promise<ToolResult> {
    const configFile = this.resolveConfig(options);
    const targetDirs = this.resolveTargetDirs(options.projectPath);
    const command = await this.resolveCommand();
    const args: string[] = [];
    if (configFile) {
      // dependency-cruiser v16+ 指定配置用 --config（--validate 已废弃）
      args.push('--config', configFile);
    }
    args.push('--output-type', 'json', ...targetDirs);

    const { stdout } = await execFileAsync(command, args, {
      cwd: options.projectPath,
      timeout: options.timeout || 180000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = JSON.parse(stdout);
    const issues = this.mapOutput(output);

    return {
      tool: 'dep-cruiser',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: output?.modules?.length || 0,
      },
    };
  }

  /** 处理 dependency-cruiser 执行错误：未安装 / 失败 */
  private handleDepCruiserError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return {
        tool: 'dep-cruiser',
        status: 'unavailable',
        issues: [],
        metadata: {
          version: '',
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error: 'dependency-cruiser 未安装',
      };
    }
    return {
      tool: 'dep-cruiser',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error: err.stderr || err.message || 'dependency-cruiser 执行失败',
    };
  }

  /**
   * 解析扫描目标目录：项目含 src/ 时扫描 src；monorepo（无根 src）时扫描各
   * packages 下的 src 子目录（避免全仓扫描过慢）；均缺失时回退整个项目。
   */
  private resolveTargetDirs(projectPath: string): string[] {
    const srcDir = path.join(projectPath, 'src');
    if (fs.existsSync(srcDir)) return [srcDir];

    const pkgsDir = path.join(projectPath, 'packages');
    if (fs.existsSync(pkgsDir)) {
      const targets: string[] = [];
      try {
        for (const entry of fs.readdirSync(pkgsDir, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          const pkgSrc = path.join(pkgsDir, entry.name, 'src');
          if (entry.isDirectory() && fs.existsSync(pkgSrc)) targets.push(pkgSrc);
        }
      } catch {
        // packages 目录不可读时走回退
      }
      if (targets.length > 0) return targets;
    }

    return [projectPath];
  }

  /**
   * 解析 dep-cruiser 校验配置：
   * 1. SOP 规则注入的 config（按回退链解析，如内核资产 @zh/kernel/dist/assets/...）
   * 2. 被扫描项目本地的 .dependency-cruiser.{cjs,js,json}
   * 均缺失返回 null（dep-cruiser 将因找不到默认配置而报错，由调用方如实上报）
   */
  private resolveConfig(options: ToolScanOptions): string | null {
    const injected = options.config?.config;
    if (typeof injected === 'string' && injected.trim()) {
      const resolved = resolveInjectedConfigPath(injected, options.projectPath, options.projectPath);
      if (resolved) return resolved;
    }
    const candidates = [
      '.dependency-cruiser.js',
      '.dependency-cruiser.cjs',
      '.dependency-cruiser.json',
    ];
    for (const name of candidates) {
      const p = path.join(options.projectPath, name);
      if (fs.existsSync(p)) return p;
      const zhshield = path.join(options.projectPath, '.zhshield', name);
      if (fs.existsSync(zhshield)) return zhshield;
    }
    return null;
  }

  private mapOutput(output: unknown): Issue[] {
    const out = output as DepCruiserOutput;
    if (!out?.summary?.violations || !Array.isArray(out.summary.violations)) return [];
    return out.summary.violations.map((v) => this.mapViolationToIssue(v));
  }

  private mapViolationToIssue(v: DepCruiserViolation): Issue {
    return {
      id: randomUUID(),
      ruleId: v.rule?.name || 'dep-cruiser/violation',
      severity: this.mapSeverity(v.rule?.severity),
      category: 'architecture',
      message: this.buildViolationMessage(v),
      file: v.from?.path || '',
      line: v.from?.line || 0,
      column: 0,
      suggestion: `模块 ${v.from?.path || ''} 不应引用 ${v.to?.path || ''}`,
      autoFixable: false,
      source: 'inspect',
      fingerprint: this.buildViolationFingerprint(v),
    };
  }

  private mapSeverity(severity: string | undefined): Issue['severity'] {
    return severity === 'error' ? 'error' : severity === 'warn' ? 'warning' : 'info';
  }

  private buildViolationMessage(v: DepCruiserViolation): string {
    return `架构边界违规: ${v.rule?.name || '未知规则'} - ${v.from?.path || '?'} → ${v.to?.path || '?'}`;
  }

  private buildViolationFingerprint(v: DepCruiserViolation): string {
    return `dep-cruiser:${v.rule?.name || ''}:${v.from?.path || ''}:${v.to?.path || ''}`;
  }
}

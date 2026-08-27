import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolAdapter, ToolMeta, ToolResult, ToolScanOptions, Issue, AccessScope } from '@zh/shared';
import { resolveToolCommand } from './tool-bin';

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
    try {
      const command = await this.resolveCommand();
      const { stdout } = await execFileAsync(command, ['--version'], { timeout: 5000 });
      return stdout.length > 0;
    } catch {
      return false;
    }
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const configFile = this.resolveConfig(options.projectPath);
    const targetDir = path.join(options.projectPath, 'src');

    try {
      const command = await this.resolveCommand();
      const args: string[] = [];
      if (configFile) {
        args.push('--validate', configFile);
      }
      args.push('--output-type', 'json', targetDir);

      const { stdout } = await execFileAsync(command, args, {
        cwd: options.projectPath,
        timeout: options.timeout || 60000,
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
    } catch (error: unknown) {
      const err = error as { code?: string; stderr?: string; message?: string };
      if (err.code === 'ENOENT') {
        return {
          tool: 'dep-cruiser',
          status: 'unavailable',
          issues: [],
          metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
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
  }

  private resolveConfig(projectPath: string): string | null {
    const candidates = [
      '.dependency-cruiser.js',
      '.dependency-cruiser.cjs',
      '.dependency-cruiser.json',
    ];
    for (const name of candidates) {
      const p = path.join(projectPath, name);
      if (fs.existsSync(p)) return p;
      const zhshield = path.join(projectPath, '.zhshield', name);
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

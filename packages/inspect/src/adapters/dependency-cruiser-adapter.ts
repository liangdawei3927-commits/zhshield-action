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

/** Dependency-cruiser JSON 输出中的单条违规。
 *  v16+ 的 from/to 为字符串路径；旧版接口可能为 { path, line } 对象。 */
interface DepCruiserNodeRef {
  path?: string;
  line?: number;
}
interface DepCruiserViolation {
  rule?: { name?: string; severity?: string };
  from?: string | DepCruiserNodeRef;
  to?: string | DepCruiserNodeRef;
}

/** Dependency-cruiser JSON 输出结构 */
interface DepCruiserOutput {
  summary?: { violations?: DepCruiserViolation[] };
}

export class DependencyCruiserAdapter implements ToolAdapter {
  meta = META;
  /** 按锚点（projectRoot ?? projectPath）缓存解析结果；isAvailable 的无锚点 PATH 探测与 scan 的项目本地解析互不污染（09-12 复验修复） */
  private readonly commandCache = new Map<string, Promise<string>>();
  private readonly projectRoot?: string;

  /** F5：dep-cruiser 校验 src/ 目录内模块依赖边界 */
  readonly accessScope: AccessScope = {
    readPaths: ['src/**', 'package.json'],
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
      cached = resolveToolCommand('depcruise', anchor);
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
      return await this.runDepCruiser(options, start);
    } catch (error: unknown) {
      return this.handleDepCruiserError(error, start);
    }
  }

  /** 执行 dependency-cruiser 并映射输出为可用结果 */
  private async runDepCruiser(options: ToolScanOptions, start: number): Promise<ToolResult> {
    // 归一化 projectPath 为绝对路径：相对路径会作为 --config/扫描目标传给 depcruise，
    // depcruise 以自身 cwd 解析导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    const configFile = this.resolveConfig(options, projectPath);
    const targetDirs = this.resolveTargetDirs(projectPath);
    // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：以扫描目标锚定本地 bin 解析
    const command = await this.resolveCommand(projectPath);
    const args: string[] = [];
    if (configFile) {
      // dependency-cruiser v16+ 指定配置用 --config（--validate 已废弃）
      args.push('--config', configFile);
    }
    args.push('--output-type', 'json', ...targetDirs);

    const { stdout } = await execFileAsync(command, args, {
      cwd: projectPath,
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
  private resolveConfig(options: ToolScanOptions, projectPath: string): string | null {
    const injected = options.config?.config;
    if (typeof injected === 'string' && injected.trim()) {
      const resolved = resolveInjectedConfigPath(injected, projectPath, projectPath);
      if (resolved) return resolved;
    }
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
    const fromPath = this.nodeRefPath(v.from);
    const toPath = this.nodeRefPath(v.to);
    return {
      id: randomUUID(),
      ruleId: v.rule?.name || 'dep-cruiser/violation',
      severity: this.mapSeverity(v.rule?.severity),
      category: 'architecture',
      message: this.buildViolationMessage(v),
      file: fromPath,
      line: this.nodeRefLine(v.from),
      column: 0,
      suggestion: `模块 ${fromPath} 不应引用 ${toPath}`,
      autoFixable: false,
      source: 'inspect',
      fingerprint: this.buildViolationFingerprint(v),
    };
  }

  private nodeRefPath(ref: string | DepCruiserNodeRef | undefined): string {
    if (typeof ref === 'string') return ref;
    return ref?.path || '';
  }

  private nodeRefLine(ref: string | DepCruiserNodeRef | undefined): number {
    if (typeof ref === 'string') return 0;
    return ref?.line || 0;
  }

  private mapSeverity(severity: string | undefined): Issue['severity'] {
    return severity === 'error' ? 'error' : severity === 'warn' ? 'warning' : 'info';
  }

  private buildViolationMessage(v: DepCruiserViolation): string {
    return `架构边界违规: ${v.rule?.name || '未知规则'} - ${this.nodeRefPath(v.from) || '?'} → ${this.nodeRefPath(v.to) || '?'}`;
  }

  private buildViolationFingerprint(v: DepCruiserViolation): string {
    return `dep-cruiser:${v.rule?.name || ''}:${this.nodeRefPath(v.from)}:${this.nodeRefPath(v.to)}`;
  }
}

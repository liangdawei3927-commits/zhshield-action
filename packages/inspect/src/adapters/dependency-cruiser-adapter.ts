import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  AccessScope,
} from '@zh/shared';
import { resolveToolCommandDetailed, type ToolCommandOrigin } from './tool-bin';
import { isCommandAvailable } from './tool-available';
import { resolveInjectedConfigPath } from './injected-config';
import { mapDepCruiserOutput } from './dependency-cruiser-mapper';
import { removeFileQuietly, writeRuleDefConfigFile } from './rule-def-config';

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
      cached = resolveToolCommandDetailed('depcruise', anchor).then((r) => r.command);
      this.commandCache.set(key, cached);
    }
    return cached;
  }

  /** 记录最近一次实际使用的命令来源，供 modules=0 时如实上报（P1 复查5） */
  private lastOrigin: ToolCommandOrigin = 'unresolved';

  private async resolveCommandDetailed(
    projectPath?: string,
  ): Promise<{ command: string; origin: ToolCommandOrigin }> {
    const anchor = this.projectRoot ?? projectPath;
    const resolved = await resolveToolCommandDetailed('depcruise', anchor);
    this.lastOrigin = resolved.origin;
    return resolved;
  }

  /** 读取已解析命令的版本号（失败返回空串，不阻断主流程） */
  private async probeVersion(command: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(command, ['--version'], { timeout: 20000 });
      return String(stdout).trim().split('\n')[0];
    } catch {
      return '';
    }
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

  /**
   * 执行 dependency-cruiser 并映射输出为可用结果。
   *
   * 配置解析分两路：SOP 规则声明了 ruleDef 时以规则为准（合成临时配置），
   * 否则沿用「项目本地 → 内核默认」的回退链。合成配置在扫描结束后清理。
   */
  private async runDepCruiser(options: ToolScanOptions, start: number): Promise<ToolResult> {
    // 归一化 projectPath 为绝对路径：相对路径会作为 --config/扫描目标传给 depcruise，
    // depcruise 以自身 cwd 解析导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    const baseConfig = this.resolveConfig(options, projectPath);
    const synthConfig = await writeRuleDefConfigFile(options.config?.rules, baseConfig);
    try {
      return await this.executeDepCruiser(options, projectPath, synthConfig ?? baseConfig, start);
    } finally {
      if (synthConfig) await removeFileQuietly(synthConfig);
    }
  }

  /** 实际执行 dep-cruiser（配置已解析完毕）并映射输出为可用结果 */
  private async executeDepCruiser(
    options: ToolScanOptions,
    projectPath: string,
    configFile: string | null,
    start: number,
  ): Promise<ToolResult> {
    const targetDirs = this.resolveTargetDirs(projectPath);
    // 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：以扫描目标锚定本地 bin 解析；
    // 同时取回来源（project-local/shared/path），供 modules=0 时如实上报（P1 复查5）
    const { command } = await this.resolveCommandDetailed(projectPath);
    const args: string[] = [];
    if (configFile) {
      // dependency-cruiser v16+ 指定配置用 --config（--validate 已废弃）
      args.push('--config', configFile);
    }
    // 扫描目标传相对路径：dep-cruiser 以 baseDir（= cwd）解析配置里 from/to 的路径正则，
    // 传绝对路径会使模块路径基准偏移，规则中形如 ^src/utils 的模式静默失配
    // （09-17 实证：绝对路径下 no-utils-to-features 不报，相对路径下正常报出）。
    // 执行 cwd 已锚定 projectPath，相对路径解析无误。
    args.push(
      '--output-type',
      'json',
      ...targetDirs.map((dir) => path.relative(projectPath, dir) || '.'),
    );

    const { stdout } = await execFileAsync(command, args, {
      cwd: projectPath,
      timeout: options.timeout || 180000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = JSON.parse(stdout);

    // 模块数为 0 但目标目录存在可扫描源文件时，说明工具版本未能正确解析
    // 项目（如全局 depcruise 18.1.1 对 TS 的已知问题），不应误报为通过。
    if (
      Array.isArray(output.modules) &&
      output.modules.length === 0 &&
      this.hasCruisableFiles(targetDirs)
    ) {
      // P1（复查5，根因于复查6 定案）：modules=0 时如实报出实际使用的
      // 命令路径/来源/版本，并指出真根因——该工具位置解析不到 typescript。
      // 2×2 对照实证（2026-09-17）：18.1.1+TS 与 18.2.0+TS 均 modules=18/violations=1，
      // 18.2.0 无 TS 时 modules=0。所以"版本不符"是假象，别再把用户往换版本上引。
      const version = await this.probeVersion(command);
      const originLabel: Record<ToolCommandOrigin, string> = {
        'project-local': '项目本地依赖',
        shared: '智汇码盾工具目录',
        path: 'PATH 全局安装（版本不可控）',
        unresolved: '未解析到',
      };
      return {
        tool: 'dep-cruiser',
        status: 'error',
        issues: [],
        metadata: {
          version,
          duration: Date.now() - start,
          timestamp: new Date(),
          fileCount: 0,
        },
        error:
          `dep-cruiser 未扫描到任何模块（modules=0），请勿视为通过。` +
          `本次实际使用：${command}（来源：${originLabel[this.lastOrigin]}${
            version ? `，版本 ${version}` : ''
          }）。` +
          `该工具所在位置解析不到 typescript，无法解析 TypeScript 依赖图。` +
          `修复：在本项目内安装（npm i -D dependency-cruiser typescript）后重试。`,
      };
    }

    const issues = mapDepCruiserOutput(output);

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

  private hasCruisableFiles(dirs: string[]): boolean {
    const CRUISABLE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
    const walk = (dir: string): boolean => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (walk(full)) return true;
          } else if (CRUISABLE_EXT.has(path.extname(entry.name))) {
            return true;
          }
        }
      } catch {
        // 目录不可读时跳过
      }
      return false;
    };
    return dirs.some(walk);
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
    // Default injected config fallback (kernel package asset)
    const defaultConfig = resolveInjectedConfigPath(
      '@zh/kernel/dist/assets/dependency-cruiser/.dependency-cruiser.cjs',
      options.projectPath,
      projectPath,
    );
    if (defaultConfig) return defaultConfig;
    return null;
  }
}

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
import {
  asToolExecError,
  buildAccessScope,
  buildToolResult,
  execTool,
  ToolCommandResolver,
} from './tool-runner';
import { resolveInjectedConfigPath } from './injected-config';
import { mapDepCruiserOutput } from './dependency-cruiser-mapper';
import { removeFileQuietly, writeRuleDefConfigFile } from './rule-def-config';

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

/** 递归探测目录是否含可被 dep-cruiser 扫描的源码文件（.ts/.tsx/.js/.jsx）；目录不可读返回 false（跳过） */
function hasCruisableWalk(dir: string): boolean {
  const CRUISABLE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // 目录不可读时跳过
    return false;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (hasCruisableWalk(full)) return true;
      continue;
    }
    if (CRUISABLE_EXT.has(path.extname(entry.name))) return true;
  }
  return false;
}

/** 组装 dep-cruiser 参数：--config + --output-type json + 相对 cwd 的扫描目标 */
function buildDepCruiserArgs(
  configFile: string | null,
  targetDirs: string[],
  projectPath: string,
): string[] {
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
  return args;
}

export class DependencyCruiserAdapter implements ToolAdapter {
  meta = META;
  private readonly commands: ToolCommandResolver;
  private readonly projectRoot?: string;

  /** F5：dep-cruiser 校验 src/ 目录内模块依赖边界 */
  readonly accessScope: AccessScope = buildAccessScope(['src/**', 'package.json']);

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot;
    this.commands = new ToolCommandResolver(
      'depcruise',
      projectRoot,
      (tool, startDir) => resolveToolCommandDetailed(tool, startDir).then((r) => r.command),
    );
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
      const { stdout } = await execTool(command, ['--version'], { timeout: 20000 });
      return String(stdout).trim().split('\n')[0];
    } catch {
      return '';
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.commands.isAvailable();
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
    const args = buildDepCruiserArgs(configFile, targetDirs, projectPath);
    const stdout = await this.runDepCruiserCommand(
      command,
      args,
      projectPath,
      options.timeout || 180000,
    );
    const output = JSON.parse(stdout);

    if (this.isZeroModules(output, targetDirs)) {
      return this.buildZeroModulesError(command, start);
    }

    return this.buildAvailableResult(output, start);
  }

  /** 执行 dep-cruiser 命令并返回原始 stdout */
  private async runDepCruiserCommand(
    command: string,
    args: string[],
    projectPath: string,
    timeout: number,
  ): Promise<string> {
    const { stdout } = await execTool(command, args, { cwd: projectPath, timeout });
    return stdout;
  }

  /** 模块数为 0 但目标目录存在可扫描源文件时，说明工具版本未能正确解析项目，不应误报为通过 */
  private isZeroModules(output: unknown, targetDirs: string[]): boolean {
    const modules = (output as { modules?: unknown[] }).modules;
    return Array.isArray(modules) && modules.length === 0 && this.hasCruisableFiles(targetDirs);
  }

  /** modules=0 时如实报出实际使用的命令路径/来源/版本，并指出真根因——该工具位置解析不到 typescript */
  private async buildZeroModulesError(command: string, start: number): Promise<ToolResult> {
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
    return buildToolResult({
      tool: 'dep-cruiser',
      status: 'error',
      issues: [],
      start,
      version,
      error:
        `dep-cruiser 未扫描到任何模块（modules=0），请勿视为通过。` +
        `本次实际使用：${command}（来源：${originLabel[this.lastOrigin]}${
          version ? `，版本 ${version}` : ''
        }）。` +
        `该工具所在位置解析不到 typescript，无法解析 TypeScript 依赖图。` +
        `修复：在本项目内安装（npm i -D dependency-cruiser typescript）后重试。`,
    });
  }

  /** 映射 dep-cruiser 输出为 Issue 并构建 available 结果 */
  private buildAvailableResult(output: unknown, start: number): ToolResult {
    const issues = mapDepCruiserOutput(output);
    return buildToolResult({
      tool: 'dep-cruiser',
      status: 'available',
      issues,
      start,
      fileCount: (output as { modules?: unknown[] })?.modules?.length || 0,
    });
  }

  /** 处理 dependency-cruiser 执行错误：未安装 / 失败 */
  private handleDepCruiserError(error: unknown, start: number): ToolResult {
    const err = asToolExecError(error);
    if (err.code === 'ENOENT') {
      return buildToolResult({
        tool: 'dep-cruiser',
        status: 'unavailable',
        issues: [],
        start,
        error: 'dependency-cruiser 未安装',
      });
    }
    return buildToolResult({
      tool: 'dep-cruiser',
      status: 'error',
      issues: [],
      start,
      error: err.stderr || err.message || 'dependency-cruiser 执行失败',
    });
  }

  /** 收集 monorepo 各 packages 子包下的 src 目标目录；packages 不可读返回空数组（调用方走回退） */
  private collectPackageSrcDirs(pkgsDir: string): string[] {
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
    return targets;
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
      const targets = this.collectPackageSrcDirs(pkgsDir);
      if (targets.length > 0) return targets;
    }

    return [projectPath];
  }

  private hasCruisableFiles(dirs: string[]): boolean {
    return dirs.some(hasCruisableWalk);
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

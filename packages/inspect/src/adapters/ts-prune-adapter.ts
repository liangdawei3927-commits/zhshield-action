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
import {
  asToolExecError,
  buildToolResult,
  buildAccessScope,
  execTool,
  ToolCommandResolver,
} from './tool-runner';
import {
  buildMonorepoPruneOverlay,
  cleanupOverlay,
  findExecutableOnPath,
  MONOREPO_OVERLAY_FILE,
  type MonorepoPruneOverlay,
  writeOverlayFile,
} from './ts-prune-adapter-overlay';
import { buildTsPruneArgs, parseTsPruneOutput } from './ts-prune-adapter-core';

// 测试与外部消费方从本模块导入解析/参数组装函数，保持既有导入路径不变
export { buildTsPruneArgs, parseTsPruneOutput, parsePruneLine } from './ts-prune-adapter-core';
export type { PruneEntry } from './ts-prune-adapter-core';

// monorepo tsconfig overlay 相关能力（测试通过本模块导入，保持既有导入路径不变）
export {
  buildMonorepoPruneOverlay,
  cleanupOverlay,
  findExecutableOnPath,
  MONOREPO_OVERLAY_FILE,
  stripJsoncComments,
  writeOverlayFile,
} from './ts-prune-adapter-overlay';
export type { MonorepoPruneOverlay } from './ts-prune-adapter-overlay';

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

export class TsPruneAdapter implements ToolAdapter {
  meta = META;
  private readonly commands: ToolCommandResolver;

  /** F5：ts-prune 基于 tsconfig 分析 TS 源码的未导出符号 */
  readonly accessScope: AccessScope = buildAccessScope(['**/*.{ts,tsx}', '**/tsconfig.json']);

  constructor(projectRoot?: string) {
    this.commands = new ToolCommandResolver('ts-prune', projectRoot);
  }

  async isAvailable(): Promise<boolean> {
    // ts-prune 的 `--version` 不短路：会连同参数当作项目扫描真实执行（实测输出为全量
    // 未导出报告而非版本号），>20s 超时 → isCommandAvailable 误判未安装。
    // 改为检查解析出的命令文件存在且可执行（解析链已覆盖本地 bin / PATH / zhshield bin）。
    try {
      const command = await this.commands.resolve();
      if (path.isAbsolute(command)) {
        await fs.promises.access(command, fs.constants.X_OK);
        return true;
      }
      return findExecutableOnPath(command);
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
    const { projectPath, overlay, overlayAbsPath, tsConfigPath, command } =
      await this.resolveTsPruneConfig(options);

    try {
      await writeOverlayFile(overlay, overlayAbsPath);
      const { stdout } = await execTool(command, buildTsPruneArgs(options, tsConfigPath), {
        cwd: projectPath,
        timeout: options.timeout || 60000,
      });
      return this.buildAvailableResult(stdout, start);
    } finally {
      await cleanupOverlay(overlay, overlayAbsPath);
    }
  }

  /**
   * 归一化 projectPath 并解析 overlay / tsconfig / 命令路径。
   * 归一化 projectPath 为绝对路径：相对路径会流入 cwd 与 tsconfig 相对化，
   * ts-prune 以自身 cwd 解析相对路径导致扫描失败。
   * monorepo 聚合 overlay：修复根 tsconfig 无 jsx/DOM/路径映射导致的系统性死代码误报
   * （App.tsx/PageShell/getOrg 等假阳性；实测单次 ~17-25s，6/6 已知符号正确）。
   * 非 monorepo（无 packages/<pkg>/tsconfig.json）时 buildMonorepoPruneOverlay 返回 null → 原行为。
   * ts-prune@0.10.3 runner 内部用 path.join(process.cwd(), tsConfigPath) 组装路径，
   * 传绝对路径会翻倍（cwd/projectPath + 绝对路径）；cwd 已是 projectPath，故传相对路径。
   * 锚定 projectPath，不受 cwd 影响（09-12 复验修复）：以扫描目标锚定本地 bin 解析。
   */
  private async resolveTsPruneConfig(options: ToolScanOptions): Promise<{
    projectPath: string;
    overlay: MonorepoPruneOverlay | null;
    overlayAbsPath: string;
    tsConfigPath: string;
    command: string;
  }> {
    const projectPath = path.resolve(options.projectPath);
    const overlay = buildMonorepoPruneOverlay(projectPath);
    const overlayAbsPath = overlay
      ? path.resolve(projectPath, MONOREPO_OVERLAY_FILE)
      : path.resolve(projectPath, 'tsconfig.json');
    const tsConfigPath = path.relative(projectPath, overlayAbsPath);
    const command = await this.commands.resolve(projectPath);
    return { projectPath, overlay, overlayAbsPath, tsConfigPath, command };
  }

  /** 将 ts-prune stdout 映射为可用扫描结果 */
  private buildAvailableResult(stdout: string, start: number): ToolResult {
    const issues = this.mapOutput(stdout);
    return buildToolResult({ tool: 'ts-prune', status: 'available', issues, start });
  }

  /** 处理 ts-prune 执行错误：未安装 / 部分输出 / 失败 */
  private handleTsPruneError(error: unknown, start: number): ToolResult {
    const err = asToolExecError(error);
    if (err.code === 'ENOENT') {
      return buildToolResult({
        tool: 'ts-prune',
        status: 'unavailable',
        issues: [],
        start,
        error: 'ts-prune 未安装',
      });
    }

    if (err.stdout) {
      const issues = this.mapOutput(err.stdout);
      if (issues.length > 0) {
        return buildToolResult({ tool: 'ts-prune', status: 'available', issues, start });
      }
    }

    return buildToolResult({
      tool: 'ts-prune',
      status: 'error',
      issues: [],
      start,
      error: err.stderr || err.message || 'ts-prune 执行失败',
    });
  }

  private mapOutput(raw: string): Issue[] {
    return parseTsPruneOutput(raw).map(({ file, line, symbol }) => ({
      id: randomUUID(),
      ruleId: 'ts-prune/unused-export',
      severity: 'info',
      category: 'quality',
      message: `未使用的导出: ${symbol}`,
      file,
      line,
      column: 0,
      suggestion: `移除未使用的导出符号: ${symbol}`,
      autoFixable: false,
      source: 'inspect',
      fingerprint: `ts-prune:${file}:${line}:${symbol}`,
    }));
  }
}

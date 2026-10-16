import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Issue, ToolMeta, ToolResult, ToolScanOptions } from '@zh/shared';
import { ToolCommandAdapter, buildAccessScope, buildToolResult, execTool } from './tool-runner';

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

/** 分步执行结果：成功携带值，失败携带已构建的 ToolResult（提前返回） */
type StepOutcome<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

/** runDepcheckCommand 的参数对象：命令行参数、扫描选项、目标路径与起始时间 */
interface RunDepcheckCommandParams {
  args: string[];
  options: ToolScanOptions;
  projectPath: string;
  start: number;
}

/**
 * 归一化 projectPath 为绝对路径：相对路径会作为扫描目标传给 depcheck，
 * depcheck 以自身 cwd 解析导致扫描失败。
 */
function normalizeProjectPath(projectPath: string): string {
  return path.resolve(projectPath);
}

export class DepcheckAdapter extends ToolCommandAdapter {
  meta = META;

  /** F5：depcheck 读 package.json 并静态解析源码 import 判断未使用依赖 */
  readonly accessScope = buildAccessScope(['**/package.json', '**/*.{ts,tsx,js,jsx}']);

  constructor(projectRoot?: string) {
    super('depcheck', projectRoot, { unavailable: 'depcheck 未安装', failed: 'depcheck 执行失败' });
  }

  /** 执行 depcheck 并映射输出为可用结果 */
  protected async runScan(options: ToolScanOptions, start: number): Promise<ToolResult> {
    const projectPath = normalizeProjectPath(options.projectPath);
    const pkgCheck = await this.ensurePackageJson(projectPath, start);
    if (!pkgCheck.ok) return pkgCheck.result;

    const command = await this.commands.resolve(options.projectPath);
    const args = buildDepcheckArgs(options, projectPath);
    const runResult = await this.runDepcheckCommand(command, {
      args,
      options,
      projectPath,
      start,
    });
    if (!runResult.ok) return runResult.result;

    const parseResult = this.parseDepcheckOutput(runResult.value, start);
    if (!parseResult.ok) return parseResult.result;

    return this.buildAvailableResult(parseResult.value, projectPath, start);
  }

  /** 校验目标目录存在 package.json，缺失时返回 unavailable 结果 */
  private async ensurePackageJson(
    projectPath: string,
    start: number,
  ): Promise<StepOutcome<true>> {
    try {
      await fs.promises.access(path.join(projectPath, 'package.json'));
      return { ok: true, value: true };
    } catch {
      return {
        ok: false,
        result: buildToolResult({
          tool: 'depcheck',
          status: 'unavailable',
          issues: [],
          start,
          error: `目标目录无 package.json（${projectPath}），跳过未使用依赖检测`,
        }),
      };
    }
  }

  /** 执行 depcheck 命令：检出未使用依赖时以非零码退出但 stdout 仍是合法 JSON（本项目实测 exit 255） */
  private async runDepcheckCommand(
    command: string,
    params: RunDepcheckCommandParams,
  ): Promise<StepOutcome<string>> {
    const { args, options, projectPath, start } = params;
    try {
      const { stdout } = await execTool(command, args, {
        cwd: projectPath,
        timeout: options.timeout || 60000,
      });
      return { ok: true, value: stdout };
    } catch (error) {
      const err = this.execErrorOf(error);
      if (err.stdout) {
        return { ok: true, value: err.stdout };
      }
      return { ok: false, result: this.buildExecErrorResult(error, start) };
    }
  }

  /** 解析 depcheck stdout 为结构化结果，非法 JSON 时返回 error 结果 */
  private parseDepcheckOutput(stdout: string, start: number): StepOutcome<DepcheckResult> {
    try {
      return { ok: true, value: JSON.parse(stdout) as DepcheckResult };
    } catch {
      return {
        ok: false,
        result: buildToolResult({
          tool: 'depcheck',
          status: 'error',
          issues: [],
          start,
          error: 'depcheck 输出不是合法 JSON',
        }),
      };
    }
  }

  /** 映射输出为 Issue 并构建 available 结果 */
  private buildAvailableResult(
    result: DepcheckResult,
    projectPath: string,
    start: number,
  ): ToolResult {
    const issues = this.mapOutput(result, projectPath);
    return buildToolResult({ tool: 'depcheck', status: 'available', issues, start });
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

/** 依据配置组装 depcheck 命令行参数：默认忽略列表始终生效，与配置中的 ignore 合并去重 */
export function buildDepcheckArgs(options: ToolScanOptions, projectPath: string): string[] {
  const args = [projectPath, '--json'];
  const cfg = options.config as Record<string, unknown> | undefined;
  if (cfg?.skip) {
    for (const s of cfg.skip as string[]) args.push('--skip', s);
  }
  const defaultIgnore = ['@types/*', 'typescript', 'eslint', 'prettier'];
  const ignoreList = [
    ...new Set([...defaultIgnore, ...((cfg?.ignore as string[] | undefined) ?? [])]),
  ];
  for (const ig of ignoreList) args.push('--ignore', ig);
  return args;
}

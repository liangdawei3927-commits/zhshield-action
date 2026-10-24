import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Issue, ToolMeta, ToolResult, ToolScanOptions } from '@zh/shared';
import { ToolCommandAdapter, buildAccessScope, buildToolResult, execTool } from './tool-runner';

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

/** 扫描目标：显式 targetFiles 优先，否则按 src/ → 项目根 探测 */
function resolvePrettierTarget(options: ToolScanOptions, projectPath: string): string {
  return options.targetFiles?.length
    ? options.targetFiles[0]
    : PrettierAdapter.pickScanTarget(projectPath);
}

export class PrettierAdapter extends ToolCommandAdapter {
  meta: ToolMeta;

  /** F5：prettier 对源码与配置文件做格式检查 */
  readonly accessScope = buildAccessScope([
    '**/*.{ts,tsx,js,jsx,mjs,cjs,json,md,yml,yaml,css,scss}',
  ]);

  constructor(projectRoot?: string) {
    super('prettier', projectRoot);
    this.meta = { ...META, description: '代码格式一致性检查（Prettier --list-different）' };
  }

  protected async runScan(options: ToolScanOptions, start: number): Promise<ToolResult> {
    // 归一化 projectPath 为绝对路径：相对路径会流入 cwd 与扫描目标，
    // prettier 以自身 cwd 解析相对路径导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    const command = await this.commands.resolve(projectPath);
    const target = resolvePrettierTarget(options, projectPath);
    const args = ['--list-different', target];
    const stdout = await this.runPrettierCommand(
      command,
      args,
      projectPath,
      options.timeout || 120000,
    );
    return this.buildPrettierResult(stdout, projectPath, start);
  }

  /** 扫描目标：优先 src/，monorepo 回退项目根（交由 .prettierignore 约束范围） */
  static pickScanTarget(projectPath: string): string {
    return fs.existsSync(path.join(projectPath, 'src')) ? 'src' : '.';
  }

  /** 执行 prettier --list-different：格式问题以退出码 1 结束并列出文件，属正常路径而非失败 */
  private async runPrettierCommand(
    command: string,
    args: string[],
    projectPath: string,
    timeout: number,
  ): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await execTool(command, args, { cwd: projectPath, timeout }));
    } catch (error: unknown) {
      // prettier 有格式问题时以退出码 1 结束并列出文件，属正常路径而非失败
      const err = this.execErrorOf(error);
      if (typeof err.code !== 'number' || err.code === 0) throw error;
      stdout = err.stdout ?? '';
    }
    return stdout;
  }

  /** 解析 --list-different 输出并构建 available 结果 */
  private buildPrettierResult(stdout: string, projectPath: string, start: number): ToolResult {
    const issues = parseListDifferent(stdout, projectPath);
    return buildToolResult({ tool: 'prettier', status: 'available', issues, start });
  }
}

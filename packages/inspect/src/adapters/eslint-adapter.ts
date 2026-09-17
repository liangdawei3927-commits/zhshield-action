import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type {
  ToolAdapter,
  ToolMeta,
  ToolResult,
  ToolScanOptions,
  Issue,
  IssueCategory,
  AccessScope,
} from '@zh/shared';
import { resolveEslintConfigPath, resolveEslintTargetDir } from '@zh/shared';
import { resolveToolCommand } from './tool-bin';
import { isCommandAvailable } from './tool-available';
import { resolveInjectedConfigPath } from './injected-config';

const execFileAsync = promisify(execFile);

/** ESLint JSON 输出中的单条消息 */
interface EslintOutputMessage {
  ruleId?: string;
  message?: string;
  line?: number;
  column?: number;
  severity?: number;
  fix?: unknown;
}

/** ESLint JSON 输出中的单个文件项 */
interface EslintOutputFile {
  filePath?: string;
  messages?: EslintOutputMessage[];
}

const META: ToolMeta = {
  id: 'eslint',
  name: 'ESLint',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  description: 'JS/TS 代码规范与质量检查',
  cliCommand: 'eslint',
  homepage: 'https://eslint.org',
  license: 'MIT',
};

export class ESLintAdapter implements ToolAdapter {
  meta = META;
  /** 按锚点（projectRoot ?? projectPath）缓存解析结果；isAvailable 的无锚点 PATH 探测与 scan 的项目本地解析互不污染（09-12 复验修复） */
  private readonly commandCache = new Map<string, Promise<string>>();
  private readonly projectRoot?: string;

  /** F5：ESLint 以 --ext .ts/.tsx/.js/.jsx 扫描 JS/TS 源码 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
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
      cached = resolveToolCommand('eslint', anchor);
      this.commandCache.set(key, cached);
    }
    return cached;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    // 归一化 projectPath 为绝对路径：相对路径会流入 cwd 与 --config 解析，
    // ESLint 以自身 cwd 解析相对路径导致扫描失败。
    const projectPath = path.resolve(options.projectPath);
    const defaultTarget = resolveEslintTargetDir(projectPath);
    const targetFiles = options.targetFiles || [defaultTarget];
    // ESLint v9 从 cwd 向上查找配置：默认扫描时以解析出的目录为 cwd，确保找到嵌套仓库的配置
    const cwd = options.targetFiles?.length ? projectPath : defaultTarget;
    const category: IssueCategory = options.config?.category ?? 'quality';

    try {
      return await this.runEslintScan(options, start, category, cwd, targetFiles, projectPath);
    } catch (error: unknown) {
      return this.handleEslintError(error, start, category);
    }
  }

  /** 执行 ESLint 扫描并映射输出为可用结果 */
  private async runEslintScan(
    options: ToolScanOptions,
    start: number,
    category: IssueCategory,
    cwd: string,
    targetFiles: string[],
    projectPath: string,
  ): Promise<ToolResult> {
    const command = await this.resolveCommand(projectPath);
    const { args, unavailable } = this.buildEslintArgs(options, cwd, targetFiles, projectPath);
    if (unavailable) return this.buildUnavailable(start, unavailable);

    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: options.timeout || 60000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const rawOutput = JSON.parse(stdout);
    const issues = this.mapOutput(rawOutput, category);

    return this.buildAvailable(start, rawOutput, issues);
  }

  /** 组装 ESLint 命令行参数（含注入 flat config 的可用性探测） */
  private buildEslintArgs(
    options: ToolScanOptions,
    cwd: string,
    targetFiles: string[],
    projectPath: string,
  ): { args: string[]; unavailable?: string } {
    const defaultExts = ['--ext', '.ts,.tsx,.js,.jsx'];
    // ESLint v9 base-path 校验：绝对 target 在 config 文件目录之外会被静默忽略，故转相对路径
    const relativeTargets = targetFiles.map((target) => path.relative(cwd, target) || '.');
    const args: string[] = ['--format', 'json', ...defaultExts, ...relativeTargets];

    // 注入的 flat config 为规则声明（如 node_modules/@zh/kernel/dist/assets/...），
    // 仅在被扫描项目内部安装了对应依赖时按 cwd 直接解析才存在。缺失时按回退链
    // （cwd → 项目根 → @zh/kernel 包内路径）解析；全部不存在时回退到项目自身实际
    // 存在的 ESLint 配置（eslint.config.* flat config 或 .eslintrc.* legacy），
    // 仍不存在才退化为 unavailable（跳过该规则），而非硬错误。
    const injectedConfig = options.config?.config;
    if (injectedConfig) {
      const configPath =
        resolveInjectedConfigPath(injectedConfig, cwd, projectPath) ??
        resolveProjectEslintConfig(projectPath);
      if (!configPath) {
        return { args, unavailable: `ESLint 配置不存在，跳过该规则: ${injectedConfig}` };
      }
      // ESLint v9 中 --no-eslintrc 已移除；--config 指定 flat config 即不再查找其他配置
      args.unshift('--config', configPath);
      return { args };
    }

    // 无注入配置时必须落到项目自身的配置：ESLint v9+ 在找不到 eslint.config.* 时
    // 会以非零退出并打印 "couldn't find an eslint.config.(js|mjs|cjs) file"。
    // 那是「没得查」，不是「查出问题」——归入 unavailable（跳过），不要让它变成 error。
    if (!resolveProjectEslintConfig(projectPath)) {
      return {
        args,
        unavailable:
          '项目未检测到 ESLint 配置（eslint.config.* / .eslintrc.*），已跳过该检查（不参与评分）',
      };
    }

    return { args };
  }

  /** 处理 ESLint 执行错误：未安装 / 部分输出 / 失败 */
  private handleEslintError(error: unknown, start: number, category: IssueCategory): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, 'ESLint 未安装或未在 PATH 中找到');
    }

    let rawOutput: unknown = null;
    if (err.stdout) {
      try {
        rawOutput = JSON.parse(err.stdout);
      } catch {
        /* ignore */
      }
    }
    if (rawOutput) {
      return this.buildAvailable(start, rawOutput, this.mapOutput(rawOutput, category));
    }

    return this.buildError(start, err.stderr || err.message || 'ESLint 执行失败');
  }

  private buildAvailable(start: number, rawOutput: unknown, issues: Issue[]): ToolResult {
    return {
      tool: 'eslint',
      status: 'available',
      issues,
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: Array.isArray(rawOutput) ? rawOutput.length : 0,
      },
    };
  }

  private buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'eslint',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private buildError(start: number, error: string): ToolResult {
    return {
      tool: 'eslint',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private mapOutput(output: unknown, category: IssueCategory = 'quality'): Issue[] {
    if (!Array.isArray(output)) return [];
    const issues: Issue[] = [];
    const files = output as EslintOutputFile[];
    for (const file of files) {
      if (!file?.messages || !Array.isArray(file.messages)) continue;
      for (const msg of file.messages) {
        if (!msg.ruleId) continue;
        issues.push(this.mapEslintMessage(msg, file, category));
      }
    }
    return issues;
  }

  private mapEslintMessage(
    msg: EslintOutputMessage,
    file: EslintOutputFile,
    category: IssueCategory,
  ): Issue {
    return {
      id: randomUUID(),
      ruleId: msg.ruleId as string,
      severity: msg.severity === 2 ? 'error' : msg.severity === 1 ? 'warning' : 'info',
      category,
      message: msg.message || `ESLint: ${msg.ruleId}`,
      file: file.filePath || '',
      line: msg.line || 0,
      column: msg.column || 0,
      suggestion: msg.fix ? '可自动修复' : undefined,
      autoFixable: !!msg.fix,
      source: 'inspect',
      fingerprint: `${msg.ruleId}:${file.filePath || ''}:${msg.line || 0}`,
    };
  }
}

/**
 * 项目自身实际存在的 ESLint 配置文件路径（flat config 优先，legacy eslintrc 兜底）。
 *
 * 统一走 @zh/shared 的候选名清单，避免此处另立一份（此前漏掉了 eslint.config.ts/.mts/.cts）。
 */
function resolveProjectEslintConfig(projectPath: string): string | null {
  return resolveEslintConfigPath(projectPath) ?? null;
}

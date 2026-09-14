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

const META: ToolMeta = {
  id: 'gitleaks',
  name: 'Gitleaks',
  category: 'inspect',
  priority: 'P0',
  installMode: 'builtin',
  description: '硬编码密钥扫描',
  cliCommand: 'gitleaks',
  homepage: 'https://github.com/gitleaks/gitleaks',
  license: 'MIT',
};

/** Gitleaks JSON 输出中的单条 finding */
interface GitleaksFinding {
  RuleID?: string;
  Description?: string;
  File?: string;
  StartLine?: number;
  StartColumn?: number;
}

/**
 * 构建产物 / 依赖 / 测试夹具不参与密钥扫描：
 * - 构建产物排除与 Guard 其他适配器排除 dist/node_modules 的约定一致。
 *   CLI 自包含 bundle（packages/cli/dist/zhshield.js）内嵌了密钥检测正则与示例字符串，
 *   提交后必然触发 "Generic API Key" 等 error 级误报并阻断门禁。
 * - 测试目录/文件中校验引擎行为的固定密钥字符串（如 fakesecret/x-api-token 断言值）
 *   是夹具而非真实泄露，与 security-check-engine 的 SKIP_DIRS（__tests__/fixtures/test）
 *   及规则模板排除测试文件的约定保持一致。
 */
const EXCLUDED_FILE_PATTERN =
  /(^|\/)(dist|build|coverage|node_modules|__tests__|__fixtures__|fixtures|test|tests)(\/|$)|\.map$|\.min\.js$|\.(test|spec)\.[jt]sx?$/;

/**
 * 展开配置路径中的环境变量占位符（${VAR} / $VAR）。
 * SOP 规则以 ${ZHSHIELD_HOME}/gitleaks.toml 声明运行时配置，execFile 不做
 * shell 展开——不展开会把字面量 ${ZHSHIELD_HOME}/gitleaks.toml 直接传给 gitleaks，
 * 导致 "unable to load gitleaks config, err: open ${ZHSHIELD_HOME}/gitleaks.toml"。
 * 未定义的环境变量展开为空串（与 shell 语义一致），由 resolveConfigPath 处理为空。
 */
function expandEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, plain: string | undefined) =>
      process.env[braced ?? plain ?? ''] ?? '',
  );
}

/**
 * 解析 gitleaks 配置文件路径：展开环境变量后仅当文件真实存在时才返回，
 * 否则返回 undefined 回退到 gitleaks 内置默认规则集（222 条）。
 * 运行时配置是可选定制项（SOP 注释明示），自定义 tOML 缺失不应把密钥扫描打成 error。
 */
function resolveConfigPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = expandEnv(raw);
  if (!expanded) return undefined;
  try {
    return fs.existsSync(expanded) ? expanded : undefined;
  } catch {
    return undefined;
  }
}

export class GitleaksAdapter implements ToolAdapter {
  meta = META;
  /** 按锚点（projectRoot ?? projectPath）缓存解析结果；isAvailable 的无锚点 PATH 探测与 scan 的项目本地解析互不污染（09-12 复验修复） */
  private readonly commandCache = new Map<string, Promise<string>>();
  private readonly projectRoot?: string;
  /** 最近一次 scan 的 projectPath，供错误分支（findings 经 stderr 返回）做相对化 */
  private lastProjectPath?: string;

  /** F5：gitleaks 读取仓库文本文件找硬编码密钥；依赖目录排除 */
  readonly accessScope: AccessScope = {
    readPaths: ['**/*.{env,ts,js,json,yaml,yml}'],
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
      cached = resolveToolCommand('gitleaks', anchor);
      this.commandCache.set(key, cached);
    }
    return cached;
  }

  async isAvailable(): Promise<boolean> {
    return isCommandAvailable(() => this.resolveCommand());
  }

  async scan(options: ToolScanOptions): Promise<ToolResult> {
    const start = Date.now();
    const isStaged = !!(options.targetFiles && options.targetFiles.length > 0);
    this.lastProjectPath = options.projectPath;

    try {
      return await this.runGitleaks(options, start, isStaged);
    } catch (error: unknown) {
      return this.handleGitleaksError(error, start);
    }
  }

  /** 执行 gitleaks 并映射输出为可用结果 */
  private async runGitleaks(
    options: ToolScanOptions,
    start: number,
    isStaged: boolean,
  ): Promise<ToolResult> {
    // 归一化 projectPath 为绝对路径：相对路径会作为 --source/位置参数传给 gitleaks，
    // gitleaks 以自身 cwd 解析导致 "stat ./scripts/fixtures/sample-repo: no such file or directory"。
    const projectPath = path.resolve(options.projectPath);
    const command = await this.resolveCommand(projectPath);
    const args = this.buildArgs(options, isStaged, projectPath);
    const { stdout } = await execFileAsync(command, args, {
      cwd: projectPath,
      // gitleaks 扫描完整 git 历史，流水线并行高负载下易超 30s，默认放宽到 120s
      timeout: options.timeout || 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout);
    const findings = Array.isArray(parsed) ? parsed : parsed?.findings || [];
    return this.buildAvailable(findings, start, projectPath);
  }

  /** 处理 gitleaks 执行错误：未安装 / 部分输出 / 失败 */
  private handleGitleaksError(error: unknown, start: number): ToolResult {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return this.buildUnavailable(start, 'Gitleaks 未安装或未在 PATH 中找到');
    }

    // gitleaks 检测到密钥时退出码非 0，但 stdout 仍含有效 JSON findings
    const partialFindings = this.parsePartialFindings(err.stdout ?? '');
    if (partialFindings) {
      return this.buildAvailable(partialFindings, start, this.lastProjectPath);
    }
    return this.buildError(start, err.stderr || err.message || 'Gitleaks 执行失败');
  }

  private parsePartialFindings(stdout: string): Record<string, unknown>[] | null {
    if (!stdout) return null;
    try {
      const parsed = JSON.parse(stdout);
      const findings = Array.isArray(parsed) ? parsed : parsed?.findings || [];
      return findings.length > 0 ? findings : null;
    } catch {
      return null;
    }
  }

  private buildArgs(options: ToolScanOptions, isStaged: boolean, projectPath: string): string[] {
    // gitleaks v8.28+ 移除了 detect 的 --format/--staged：JSON 输出统一走全局
    // --report-format/--report-path（"-"=stdout）；暂存扫描走 `git --staged` 子命令（仓库路径为位置参数，不支持 --source）。
    const args = isStaged ? ['git', '--staged'] : ['detect', '--source', projectPath];
    args.push('--report-format', 'json', '--report-path', '-');
    if (isStaged) {
      args.push(projectPath);
    } else if (!this.isGitRepo(projectPath)) {
      // 目标目录非 git 仓库时（如验收 fixture 无 .git），gitleaks 默认沿父目录向上找最近
      // 的 git 仓库并只扫已跟踪文件，untracked 目标整体漏检；加 --no-git 强制扫工作树（09-12 复验修复）。
      args.push('--no-git');
    }
    const configPath = resolveConfigPath(options.config?.config);
    if (configPath) {
      args.push('--config', configPath);
    }
    return args;
  }

  private isGitRepo(projectPath: string): boolean {
    try {
      return fs.existsSync(path.join(projectPath, '.git'));
    } catch {
      return false;
    }
  }

  private buildAvailable(findings: Record<string, unknown>[], start: number, projectPath?: string): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'available',
      issues: this.mapOutput(findings, projectPath),
      metadata: {
        version: '',
        duration: Date.now() - start,
        timestamp: new Date(),
        fileCount: findings.length,
      },
    };
  }

  private buildUnavailable(start: number, error: string): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'unavailable',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private buildError(start: number, error: string): ToolResult {
    return {
      tool: 'gitleaks',
      status: 'error',
      issues: [],
      metadata: { version: '', duration: Date.now() - start, timestamp: new Date(), fileCount: 0 },
      error,
    };
  }

  private mapOutput(findings: Record<string, unknown>[], projectPath?: string): Issue[] {
    if (!Array.isArray(findings)) return [];
    // gitleaks 对 --source 返回绝对路径 File；相对化到扫描根后再做排除判断，
    // 否则扫描根自身路径含 fixtures/dist 等段时（如验收 fixture）会被误过滤（09-12 复验修复）。
    const normalize = (f: string): string => {
      if (!projectPath) return f;
      const rel = path.relative(projectPath, f);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : f;
    };
    return findings
      .filter((f) => {
        const finding = f as GitleaksFinding;
        return !EXCLUDED_FILE_PATTERN.test(normalize(finding.File || ''));
      })
      .map((f) => {
        const finding = f as GitleaksFinding;
        const file = normalize(finding.File || '');
        return {
          id: randomUUID(),
          ruleId: finding.RuleID || 'gitleaks-unknown',
          severity: 'error',
          category: 'security',
          message: finding.Description || `检测到硬编码密钥: ${finding.RuleID || '未知'}`,
          file,
          line: finding.StartLine || 0,
          column: finding.StartColumn || 0,
          suggestion: '移除硬编码密钥，使用环境变量或密钥管理服务',
          autoFixable: false,
          source: 'inspect',
          fingerprint: `gitleaks:${finding.RuleID || ''}:${file}:${finding.StartLine || 0}`,
        };
      });
  }
}

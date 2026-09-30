import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adapter, CheckConfig, CheckResult } from '../types';
import { makeAdapterResult, makeSkippedAdapterResult } from './adapter-result';
import {
  findEslintConfigDir,
  resolveEslintTargetDir,
  resolveToolCommandDetailed,
} from '@zh/shared';

const execFileAsync = promisify(execFile);

/**
 * 单次 ESLint 扫描的执行预算，对齐 SOP 引擎硬上限 300s。
 * 此前为 60s，比外层硬上限更紧：门禁与其他扫描器并行时大型 monorepo 的全量
 * lint 会被 SIGTERM，ESLint 末尾一次性输出 JSON 遂双空，失败原因退化成
 * 不可读的 `Command failed: <cmd>`。
 */
const DEFAULT_SCAN_TIMEOUT_MS = 300_000;

export { resolveEslintTargetDir };

/** 适配器原始输出：成功/失败的文件列表，或「跳过」原因 */
interface EslintRawResult {
  files: Record<string, unknown>[];
  error?: string;
  /** 项目未配置 ESLint 时的跳过原因 —— 不是失败，不应判 error */
  skipped?: string;
}

/** ESLint v9+ 在无配置文件时的报错特征（英文原文，随版本略有差异） */
const MISSING_CONFIG_RE =
  /couldn't find an eslint\.config|no eslint configuration found|eslint\.config\.\(js\|mjs\|cjs\)|Please install ESLint configuration/i;

/** ESLint JSON 输出中的单条消息 */
interface EslintMessage {
  ruleId?: string;
  message?: string;
  line?: number;
  column?: number;
  severity?: number;
}

/** ESLint JSON 输出中的单个文件项 */
interface EslintFile {
  filePath?: string;
  messages?: EslintMessage[];
}

/**
 * Guard ESLint 检查适配器 — L1 门禁
 *
 * 适配器契约:
 * - run(): 执行 ESLint CLI（异步），返回原始 JSON 输出
 * - normalize(): 将原始输出转为 CheckResult（同步）
 *
 * GuardEngine 调用模式:
 *   const raw = await Promise.resolve(adapter.run(ctx, check));
 *   results.push(adapter.normalize(raw, ctx, check));
 */
export class GuardESLintCheckAdapter implements Adapter {
  async run(
    context: { targetFiles?: string[]; projectPath?: string },
    _check: CheckConfig,
  ): Promise<EslintRawResult> {
    const projectPath = context.projectPath;
    if (!projectPath) throw new Error(`${_check.checkId}: 缺少 projectPath 上下文，无法确定扫描目录`);
    const targetDir = resolveEslintTargetDir(projectPath);

    // 项目自身没有任何 ESLint 配置时，ESLint v9+ 必然以非零退出并打印
    // "couldn't find an eslint.config.(js|mjs|cjs) file" —— 那是「没得查」，
    // 不是「查出问题」。先探测再决定，避免把覆盖率缺口报成检查失败。
    if (!findEslintConfigDir([targetDir, projectPath])) {
      return {
        files: [],
        skipped: `未检测到 ESLint 配置（eslint.config.* / .eslintrc.*），已跳过该检查。如需纳入门禁，请在项目根添加 ESLint 配置`,
      };
    }

    try {
      const { stdout } = await this.runEslint(targetDir);
      return this.parseSuccessOutput(stdout);
    } catch (error: unknown) {
      return this.handleRunError(error);
    }
  }

  /** 执行 ESLint CLI 并返回原始输出 */
  private async runEslint(targetDir: string): Promise<{ stdout: string; stderr: string }> {
    // 统一解析：项目本地 → ~/.zhshield/bin → PATH（裸命令只认 PATH，
    // 会让码盾自装的 eslint 在门禁里报「未安装」）
    const { command } = await resolveToolCommandDetailed('eslint', targetDir);
    return execFileAsync(command, ['--format', 'json', '--ext', '.ts,.tsx,.js,.jsx', targetDir], {
      cwd: targetDir,
      timeout: DEFAULT_SCAN_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
  }

  /** 解析成功输出：空输出视为无文件，非法 JSON 归为执行失败 */
  private parseSuccessOutput(stdout: string): EslintRawResult {
    if (!stdout) return { files: [] };

    const parsed = JSON.parse(stdout);
    return { files: Array.isArray(parsed) ? parsed : [] };
  }

  /** 处理 ESLint 执行失败：区分未安装 / 超时被杀 / 缺配置（应跳过）/ lint 失败有输出 / 其他错误 */
  private handleRunError(error: unknown): EslintRawResult {
    const err = error as { code?: string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') return this.notInstalledResult();
    const lintOutput = this.parseLintOutput(err.stdout ?? '');
    if (lintOutput) return { files: lintOutput };
    if (this.isTimeoutError(err)) return this.timeoutResult();
    if (this.isMissingConfigError(err)) return this.missingConfigResult();
    return this.genericErrorResult(err);
  }

  /** 超时判定：Node 超时置 killed=true + signal='SIGTERM' + code=null，stdout/stderr 常双空 */
  private isTimeoutError(err: { code?: string; killed?: boolean; signal?: string | null; stdout?: string; stderr?: string }): boolean {
    if (err.killed === true) return true;
    return err.code === null && err.signal === 'SIGTERM' && !err.stdout && !err.stderr;
  }

  private timeoutResult(): EslintRawResult {
    return {
      files: [],
      error:
        `ESLint 扫描超时（${DEFAULT_SCAN_TIMEOUT_MS}ms 内未完成，已终止进程）：` +
        '请缩小扫描范围或显式放宽该检查的执行预算。',
    };
  }

  private notInstalledResult(): EslintRawResult {
    return { files: [], error: 'ESLint 未安装或未在 PATH 中找到' };
  }

  private missingConfigResult(): EslintRawResult {
    return {
      files: [],
      skipped: 'ESLint 未找到可用配置（eslint.config.* / .eslintrc.*），已跳过该检查',
    };
  }

  private genericErrorResult(err: { stderr?: string; message?: string }): EslintRawResult {
    return { files: [], error: err.stderr || err.message || 'ESLint 执行失败' };
  }

  private isMissingConfigError(err: { stderr?: string; message?: string }): boolean {
    // 兜底：探测漏掉的自定义配置名（如 eslint.config.ts 需额外依赖）也会走到这里，
    // 按报错文案识别「缺配置」，仍然跳过而不是判失败。
    const text = `${err.stderr ?? ''}${err.message ?? ''}`;
    return MISSING_CONFIG_RE.test(text);
  }

  private parseLintOutput(stdout: string): Record<string, unknown>[] | null {
    // ESLint 以非零退出时有 JSON 输出（lint 失败）
    if (!stdout) return null;
    try {
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  normalize(rawResult: EslintRawResult, context: unknown, check: CheckConfig): CheckResult {
    if (rawResult.skipped) {
      return makeSkippedAdapterResult(check, rawResult.skipped);
    }
    if (rawResult.error) {
      return makeAdapterResult(check, 'error', rawResult.error);
    }

    const files = rawResult.files;
    if (files.length === 0) {
      return makeAdapterResult(check, 'passed', 'ESLint 检查通过（无输出）');
    }

    const { errors, warnings } = this.collectMessages(files);
    return this.buildLintResult(check, files, errors, warnings);
  }

  /** 按错误 / 警告 / 通过三种情况构造结果 */
  private buildLintResult(
    check: CheckConfig,
    files: Record<string, unknown>[],
    errors: string[],
    warnings: string[],
  ): CheckResult {
    if (errors.length > 0) {
      return makeAdapterResult(
        check,
        'failed',
        `ESLint 发现 ${errors.length} 个错误:\n${errors.join('\n')}`,
        { errors, warnings, totalErrors: errors.length, totalWarnings: warnings.length },
      );
    }

    if (warnings.length > 0 && check.severity !== 'error') {
      return makeAdapterResult(
        check,
        'warning',
        `ESLint 发现 ${warnings.length} 个警告:\n${warnings.join('\n')}`,
        { errors, warnings, totalErrors: 0, totalWarnings: warnings.length },
      );
    }

    return makeAdapterResult(check, 'passed', `ESLint 检查通过（${files.length} 个文件）`);
  }

  private collectMessages(files: Record<string, unknown>[]): {
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const file of files) {
      const eslintFile = file as EslintFile;
      if (!eslintFile?.messages || !Array.isArray(eslintFile.messages)) continue;
      for (const msg of eslintFile.messages) {
        if (!msg.ruleId) continue;
        const location = `${eslintFile.filePath || ''}:${msg.line || 0}:${msg.column || 0}`;
        const entry = `[${msg.ruleId}] ${msg.message} (${location})`;
        if (msg.severity === 2) {
          errors.push(entry);
          continue;
        }
        if (msg.severity === 1) {
          warnings.push(entry);
        }
      }
    }

    return { errors, warnings };
  }
}

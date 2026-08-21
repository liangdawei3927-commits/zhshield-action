import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeEnv } from '@zh/shared';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';

const execFileAsync = promisify(execFile);

const ESLINT_CONFIG_NAMES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc',
] as const;

function hasEslintConfig(dir: string): boolean {
  return ESLINT_CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)));
}

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
 * 探测 ESLint 应扫描的目录（ESLint 从该目录向上查找配置）：
 * 1. 项目根含 eslint 配置 → 项目根
 * 2. 一层子目录含 eslint 配置（嵌套仓库，如 zhiyan-codeshield/）→ 该子目录
 * 3. 有 src / packages → 对应源码目录
 * 4. 兜底项目根
 */
export function resolveEslintTargetDir(projectPath: string): string {
  if (hasEslintConfig(projectPath)) return projectPath;

  const entries = fs.existsSync(projectPath) ? fs.readdirSync(projectPath) : [];
  for (const entry of entries) {
    const child = path.join(projectPath, entry);
    try {
      if (fs.statSync(child).isDirectory() && hasEslintConfig(child)) return child;
    } catch {
      // 忽略损坏的符号链接 / 无权限目录
    }
  }

  for (const candidate of ['src', 'packages']) {
    const dir = path.join(projectPath, candidate);
    if (fs.existsSync(dir)) return dir;
  }
  return projectPath;
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
  ): Promise<{ files: Record<string, unknown>[]; error?: string }> {
    const projectPath = context.projectPath || process.cwd();
    const targetDir = resolveEslintTargetDir(projectPath);

    try {
      const { stdout } = await this.runEslint(targetDir);
      return this.parseSuccessOutput(stdout);
    } catch (error: unknown) {
      return this.handleRunError(error);
    }
  }

  /** 执行 ESLint CLI 并返回原始输出 */
  private runEslint(targetDir: string): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(
      'eslint',
      ['--format', 'json', '--ext', '.ts,.tsx,.js,.jsx', targetDir],
      {
        cwd: targetDir,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: sanitizeEnv(),
      },
    );
  }

  /** 解析成功输出：空输出视为无文件，非法 JSON 归为执行失败 */
  private parseSuccessOutput(stdout: string): { files: Record<string, unknown>[]; error?: string } {
    if (!stdout) return { files: [] };

    const parsed = JSON.parse(stdout);
    return { files: Array.isArray(parsed) ? parsed : [] };
  }

  /** 处理 ESLint 执行失败：区分未安装 / lint 失败有输出 / 其他错误 */
  private handleRunError(error: unknown): { files: Record<string, unknown>[]; error?: string } {
    const err = error as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (err.code === 'ENOENT') {
      return { files: [], error: 'ESLint 未安装或未在 PATH 中找到' };
    }

    // ESLint 以非零退出时有 JSON 输出（lint 失败）
    const parsed = this.parseLintOutput(err.stdout ?? '');
    if (parsed) return { files: parsed };

    return { files: [], error: err.stderr || err.message || 'ESLint 执行失败' };
  }

  private parseLintOutput(stdout: string): Record<string, unknown>[] | null {
    if (!stdout) return null;
    try {
      const parsed = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  normalize(
    rawResult: { files: Record<string, unknown>[]; error?: string },
    context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return this.makeResult(check, 'error', rawResult.error);
    }

    const files = rawResult.files;
    if (files.length === 0) {
      return this.makeResult(check, 'passed', 'ESLint 检查通过（无输出）');
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
      return this.makeResult(
        check,
        'failed',
        `ESLint 发现 ${errors.length} 个错误:\n${errors.join('\n')}`,
        { errors, warnings, totalErrors: errors.length, totalWarnings: warnings.length },
      );
    }

    if (warnings.length > 0 && check.severity !== 'error') {
      return this.makeResult(
        check,
        'warning',
        `ESLint 发现 ${warnings.length} 个警告:\n${warnings.join('\n')}`,
        { errors, warnings, totalErrors: 0, totalWarnings: warnings.length },
      );
    }

    return this.makeResult(
      check,
      'passed',
      `ESLint 检查通过（${files.length} 个文件）`,
    );
  }

  private collectMessages(files: Record<string, unknown>[]): { errors: string[]; warnings: string[] } {
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

  private makeResult(
    check: CheckConfig,
    status: CheckStatus,
    message: string,
    details?: unknown,
  ): CheckResult {
    return {
      checkId: check.checkId,
      adapter: check.adapter,
      status,
      severity: status === 'failed' || status === 'error' ? check.severity : 'info',
      blocking: check.blocking && (status === 'failed' || status === 'error'),
      message,
      details,
    };
  }
}

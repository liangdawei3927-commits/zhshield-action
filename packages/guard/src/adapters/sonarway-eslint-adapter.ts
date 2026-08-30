// Guard SonarWay ESLint 适配器 — L1 门禁（内置标准规则集）
//
// 与 GuardESLintCheckAdapter 的区别：
//   · GuardESLintCheckAdapter 尊重被检项目自身的 ESLint 配置（execFile 调用户环境 eslint）
//   · 本适配器使用智汇码盾【内置】SonarWay 规则集（eslint-plugin-sonarjs），
//     不依赖被检项目是否安装/配置 ESLint —— 保证"内置标准规则集"作为免费层能力一致生效
//
// 实现：通过 ESLint Node API + 内置 flat config 跑 SonarWay，输出按 ruleId 解析为 CheckResult。
import { ESLint } from 'eslint';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';
import { buildSonarwayConfig } from './eslint-sonarway-config';

/** ESLint 输出消息 */
interface LintMessage {
  ruleId?: string;
  message?: string;
  line?: number;
  column?: number;
  severity?: number;
  fatal?: boolean;
}

/** 单个文件的 lint 结果 */
interface LintResult {
  filePath: string;
  messages: LintMessage[];
  errorCount?: number;
  warningCount?: number;
}

/**
 * Guard SonarWay ESLint 检查适配器
 * 契约与 GuardESLintCheckAdapter 一致：run() → normalize()
 */
export class GuardSonarwayESLintAdapter implements Adapter {
  /** 内置 flat config（含 sonarjs 插件 + 高价值 bug 规则） */
  private config = buildSonarwayConfig();

  async run(
    context: { targetFiles?: string[]; projectPath?: string },
    check: CheckConfig,
  ): Promise<{ results: LintResult[]; error?: string }> {
    const projectPath = context.projectPath || process.cwd();
    const target =
      context.targetFiles && context.targetFiles.length > 0
        ? context.targetFiles
        : this.resolveSourceTarget(projectPath);
    return this.lintWithConfig(projectPath, target);
  }

  /** 用内置 SonarWay config 执行 ESLint 扫描，返回有消息的文件（失败降级为空结果 + error） */
  private async lintWithConfig(projectPath: string, target: string | string[]): Promise<{ results: LintResult[]; error?: string }> {
    try {
      const eslint = new ESLint({
        cwd: projectPath,
        // 强制使用内置 config，不读取项目自身配置（保证标准规则集一致）
        overrideConfigFile: true,
        overrideConfig: this.config as never,
      });

      const results = (await eslint.lintFiles(target)) as unknown as LintResult[];
      const filtered = results.filter((r) => r.messages.length > 0);
      return { results: filtered };
    } catch (error) {
      return { results: [], error: this.describeError(error) };
    }
  }

  /** 解析源码探测目标（默认项目根下 src） */
  private resolveSourceTarget(projectPath: string): string {
    const src = path.join(projectPath, 'src');
    return fs.existsSync(src) ? src : projectPath;
  }

  private describeError(error: unknown): string {
    const e = error as { message?: string };
    return e?.message || 'ESLint/SonarWay 执行失败';
  }

  normalize(
    rawResult: { results: LintResult[]; error?: string },
    _context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return this.makeResult(check, 'error', rawResult.error, { errors: [], warnings: [], totalErrors: 0, totalWarnings: 0 });
    }

    const { errors, warnings } = this.collectMessages(rawResult.results);
    return this.buildNormalizedResult(check, errors, warnings);
  }

  /** 按错误/警告/通过聚合出最终 CheckResult（基于已收集的消息） */
  private buildNormalizedResult(
    check: CheckConfig,
    errors: (string | undefined)[],
    warnings: (string | undefined)[],
  ): CheckResult {
    if (errors.length > 0) {
      return this.makeResult(
        check,
        'failed',
        `SonarWay 发现 ${errors.length} 个错误:\n${errors.join('\n')}`,
        { errors, warnings, totalErrors: errors.length, totalWarnings: warnings.length },
      );
    }

    if (warnings.length > 0 && check.severity !== 'error') {
      return this.makeResult(
        check,
        'warning',
        `SonarWay 发现 ${warnings.length} 个警告:\n${warnings.join('\n')}`,
        { errors, warnings, totalErrors: 0, totalWarnings: warnings.length },
      );
    }

    return this.makeResult(check, 'passed', 'SonarWay 检查通过');
  }

  private collectMessages(results: LintResult[]): { errors: (string | undefined)[]; warnings: (string | undefined)[] } {
    const errors: (string | undefined)[] = [];
    const warnings: (string | undefined)[] = [];

    for (const file of results) {
      if (!file.messages?.length) continue;
      for (const msg of file.messages) {
        if (!msg.ruleId) continue;
        const location = `${file.filePath}:${msg.line || 0}:${msg.column || 0}`;
        const entry = `[${msg.ruleId}] ${msg.message} (${location})`;
        if (msg.severity === 2 && !msg.fatal) {
          errors.push(entry);
        } else if (msg.severity === 1) {
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

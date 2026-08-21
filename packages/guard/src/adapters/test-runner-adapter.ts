import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sanitizeEnv } from '@zh/shared';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';
import { TestCommandDetector } from './test-command-detector';
import type { TestResult } from './test-result';
import { VitestOutputParser } from './vitest-output-parser';

const execFileAsync = promisify(execFile);

/**
 * Test runner adapter — runs project tests and reports pass/fail counts.
 *
 * Strategy:
 * 1. Detect test framework from package.json scripts（TestCommandDetector）
 * 2. Run the test command
 * 3. Parse output for test result summary（VitestOutputParser）
 */
export class TestRunnerAdapter implements Adapter {
  private readonly commandDetector = new TestCommandDetector();
  private readonly outputParser = new VitestOutputParser();

  async run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): Promise<{ result: TestResult | null; error?: string }> {
    const projectPath = context.repoRoot || context.projectPath || process.cwd();
    const resolved = this.commandDetector.resolveProjectDir(projectPath);
    if ('error' in resolved) {
      return { result: null, error: resolved.error };
    }

    const detected = this.commandDetector.detectTestCommand(resolved.dir);
    if ('error' in detected) {
      return { result: null, error: detected.error };
    }

    const startTime = Date.now();
    try {
      const { stdout, stderr } = await this.executeTestRun(detected.testCmd, detected.testArgs, resolved.dir);

      const output = stdout + '\n' + stderr;
      const result = this.outputParser.parseOutput(output, startTime);
      return { result: this.applyDiskFallback(result, resolved.dir) };
    } catch (error: unknown) {
      return this.handleRunFailure(error, startTime, resolved.dir);
    }
  }

  /** 输出中解析不到测试计数时，以磁盘真实测试文件数兜底（避免误报「未发现测试用例」） */
  private applyDiskFallback(result: TestResult, projectPath: string): TestResult {
    if (result.totalTests > 0) return result;
    const onDisk = this.outputParser.countTestFilesOnDisk(projectPath);
    if (onDisk > 0) {
      return { ...result, totalTests: onDisk, passed: 0, failed: 0, unresolved: true };
    }
    return result;
  }

  /** 执行测试命令并返回标准输出 */
  private executeTestRun(
    testCmd: string,
    testArgs: string[],
    projectPath: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(
      testCmd || 'npx',
      testArgs.length > 0 ? testArgs : ['vitest', 'run'],
      {
        cwd: projectPath,
        // 冷缓存下整套 turbo 测试耗时约 4 分钟，120s 超时会提前杀死测试进程，
        // 导致 vitest 汇总行尚未输出而被误报「未发现测试用例」
        timeout: 600000,
        maxBuffer: 10 * 1024 * 1024,
        env: sanitizeEnv(process.env, { CI: 'true' }),
      },
    );
  }

  /** 处理测试执行失败：非零退出或有输出时仍解析结果，输出无汇总行时同样应用磁盘兜底 */
  private handleRunFailure(
    error: unknown,
    startTime: number,
    projectPath: string,
  ): { result: TestResult | null; error?: string } {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    // Tests may exit non-zero when tests fail — that's OK, parse the output
    const output = (err.stdout || '') + '\n' + (err.stderr || '');
    if (output) {
      const result = this.outputParser.parseOutput(output, startTime);
      return { result: this.applyDiskFallback(result, projectPath) };
    }
    return { result: null, error: err.message || 'Test execution failed' };
  }

  normalize(
    rawResult: { result: TestResult | null; error?: string },
    _context: unknown,
    check: CheckConfig,
  ): CheckResult {
    if (rawResult.error) {
      return this.makeResult(check, 'error', `测试执行失败: ${rawResult.error}`);
    }

    const r = rawResult.result;
    if (!r) {
      return this.makeResult(check, 'error', '测试未执行');
    }

    return this.buildOutcomeResult(check, r);
  }

  private buildOutcomeResult(check: CheckConfig, r: TestResult): CheckResult {
    if (r.unresolved) {
      return this.makeResult(
        check,
        'warning',
        `检测到 ${r.totalTests} 个测试文件，但测试运行结果未能解析（进程输出异常或超时）`,
        { totalTests: r.totalTests, passed: 0, failed: 0, skipped: 0, durationMs: r.durationMs, unresolved: true },
      );
    }

    if (r.failed > 0) {
      return this.buildFailedResult(check, r);
    }

    if (r.totalTests === 0) {
      return this.makeResult(check, 'warning', '未发现测试用例', { totalTests: 0 });
    }

    return this.buildPassedResult(check, r);
  }

  private buildFailedResult(check: CheckConfig, r: TestResult): CheckResult {
    const failDetail = r.details.length > 0
      ? `\n失败用例:\n${r.details.slice(0, 5).join('\n')}`
      : '';
    return this.makeResult(
      check,
      'failed',
      `测试 ${r.totalTests} 项: ${r.passed} 通过, ${r.failed} 失败 (${r.durationMs}ms)${failDetail}`,
      { totalTests: r.totalTests, passed: r.passed, failed: r.failed, skipped: r.skipped, durationMs: r.durationMs },
    );
  }

  private buildPassedResult(check: CheckConfig, r: TestResult): CheckResult {
    return this.makeResult(
      check,
      'passed',
      `全部 ${r.passed} 项测试通过 (${r.durationMs}ms)`,
      { totalTests: r.totalTests, passed: r.passed, durationMs: r.durationMs },
    );
  }

  private makeResult(check: CheckConfig, status: CheckStatus, message: string, details?: unknown): CheckResult {
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

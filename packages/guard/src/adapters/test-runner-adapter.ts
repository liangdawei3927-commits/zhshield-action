import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';
import type { TestResult } from './test-result';
import { VitestOutputParser } from './vitest-output-parser';
import { TestCommandDetector } from './test-command-detector';

const execFileAsync = promisify(execFile);

/**
 * Test runner adapter — runs project tests and reports pass/fail counts.
 *
 * Strategy:
 * 1. Detect test framework from package.json scripts
 * 2. Run the test command
 * 3. Parse output for test result summary
 */
export class TestRunnerAdapter implements Adapter {
  private outputParser = new VitestOutputParser();
  private commandDetector = new TestCommandDetector();

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
      return { result: this.withDiskFallback(this.outputParser.parseOutput(output, startTime), resolved.dir) };
    } catch (error: unknown) {
      return this.handleRunFailure(error, startTime, resolved.dir);
    }
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
        // 冷缓存跑整套测试约 4 分钟（zhshield-mcp.ts 同款实测结论）：120s 会把
        // 尚未输出汇总行的运行整体杀死 → 解析不到计数 → 误报「测试结果未知」
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, CI: 'true' },
      },
    );
  }

  /** 处理测试执行失败：非零退出但有输出时仍解析结果 */
  private handleRunFailure(
    error: unknown,
    startTime: number,
    projectPath: string,
  ): { result: TestResult | null; error?: string } {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    // Tests may exit non-zero when tests fail — that's OK, parse the output
    const output = (err.stdout || '') + '\n' + (err.stderr || '');
    if (output) {
      return { result: this.withDiskFallback(this.outputParser.parseOutput(output, startTime), projectPath) };
    }
    return { result: null, error: err.message || 'Test execution failed' };
  }

  /** 输出解析不到测试计数时，以磁盘真实测试文件数兜底并标记 unresolved（测试存在但运行结果未知） */
  private withDiskFallback(result: TestResult, projectPath: string): TestResult {
    if (result.totalTests > 0) return result;
    const testFilesOnDisk = this.outputParser.countTestFilesOnDisk(projectPath);
    return { ...result, totalTests: testFilesOnDisk, unresolved: true };
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

    // 输出解析失败（unresolved）时 totalTests 为磁盘兜底的测试文件数：
    // 磁盘有测试 → 结果未知报 warning；磁盘也无测试 → 才是真正的「未发现测试用例」
    if (r.unresolved) {
      if (r.totalTests > 0) {
        return this.makeResult(
          check,
          'warning',
          `测试命令输出解析失败，磁盘发现 ${r.totalTests} 个测试文件，测试结果未知`,
          { totalTests: r.totalTests, passed: r.passed, failed: r.failed, unresolved: true },
        );
      }
      return this.makeResult(check, 'warning', '未发现测试用例', { totalTests: 0 });
    }

    if (r.failed > 0) {
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

    if (r.totalTests === 0) {
      return this.makeResult(check, 'warning', '未发现测试用例', { totalTests: 0 });
    }

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

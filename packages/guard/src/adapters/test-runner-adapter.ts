import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Adapter, CheckConfig, CheckResult } from '../types';
import { makeAdapterResult, makeSkippedAdapterResult, resolveScanTargetDir } from './adapter-result';
import type { TestResult } from './test-result';
import { VitestOutputParser } from './vitest-output-parser';
import { TestCommandDetector, isNoTestConfiguredReason } from './test-command-detector';

const execFileAsync = promisify(execFile);

/** 适配器原始输出：测试结果，或「跳过」原因，或真实错误 */
interface TestRunnerRawResult {
  result: TestResult | null;
  error?: string;
  /** 项目未配置测试时的跳过原因 —— 覆盖率缺口，不判失败 */
  skipped?: string;
}

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
  ): Promise<TestRunnerRawResult> {
    const projectPath = resolveScanTargetDir(context, _check.checkId);
    const resolved = this.commandDetector.resolveProjectDir(projectPath);
    if ('error' in resolved) {
      return this.handleDetectionFailure(resolved.error);
    }

    const detected = this.commandDetector.detectTestCommand(resolved.dir);
    if ('error' in detected) {
      return this.handleDetectionFailure(detected.error);
    }

    return this.runDetectedTest(detected, resolved.dir);
  }

  /** 探测阶段失败：项目压根没配测试 → 跳过；其余（如损坏的 package.json）才判错误 */
  private handleDetectionFailure(reason: string): TestRunnerRawResult {
    if (isNoTestConfiguredReason(reason)) {
      return {
        result: null,
        skipped: `项目未配置测试脚本（package.json 缺少 test / test:run / vitest 脚本），已跳过该检查`,
      };
    }
    return { result: null, error: reason };
  }

  /** 执行已检测到的测试命令并解析输出，失败时走兜底解析 */
  private async runDetectedTest(
    detected: { testCmd: string; testArgs: string[] },
    projectPath: string,
  ): Promise<TestRunnerRawResult> {
    const startTime = Date.now();
    try {
      const { stdout, stderr } = await this.executeTestRun(
        detected.testCmd,
        detected.testArgs,
        projectPath,
      );

      const output = stdout + '\n' + stderr;
      return {
        result: this.withDiskFallback(
          this.outputParser.parseOutput(output, startTime),
          projectPath,
        ),
      };
    } catch (error: unknown) {
      return this.handleRunFailure(error, startTime, projectPath);
    }
  }

  /** 执行测试命令并返回标准输出 */
  private executeTestRun(
    testCmd: string,
    testArgs: string[],
    projectPath: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(testCmd || 'npx', testArgs.length > 0 ? testArgs : ['vitest', 'run'], {
      cwd: projectPath,
      // 冷缓存跑整套测试约 4 分钟（zhshield-mcp.ts 同款实测结论）：120s 会把
      // 尚未输出汇总行的运行整体杀死 → 解析不到计数 → 误报「测试结果未知」
      timeout: 600_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CI: 'true' },
    });
  }

  /** 处理测试执行失败：非零退出但有输出时仍解析结果 */
  private handleRunFailure(
    error: unknown,
    startTime: number,
    projectPath: string,
  ): TestRunnerRawResult {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    // Tests may exit non-zero when tests fail — that's OK, parse the output
    const output = (err.stdout || '') + '\n' + (err.stderr || '');
    if (output) {
      return {
        result: this.withDiskFallback(
          this.outputParser.parseOutput(output, startTime),
          projectPath,
        ),
      };
    }
    return { result: null, error: err.message || 'Test execution failed' };
  }

  /** 输出解析不到测试计数时，以磁盘真实测试文件数兜底并标记 unresolved（测试存在但运行结果未知） */
  private withDiskFallback(result: TestResult, projectPath: string): TestResult {
    if (result.totalTests > 0) return result;
    const testFilesOnDisk = this.outputParser.countTestFilesOnDisk(projectPath);
    return { ...result, totalTests: testFilesOnDisk, unresolved: true };
  }

  normalize(rawResult: TestRunnerRawResult, _context: unknown, check: CheckConfig): CheckResult {
    if (rawResult.skipped) {
      return makeSkippedAdapterResult(check, rawResult.skipped);
    }
    if (rawResult.error) {
      return makeAdapterResult(check, 'error', `测试执行失败: ${rawResult.error}`);
    }
    const r = rawResult.result;
    if (!r) {
      return makeAdapterResult(check, 'error', '测试未执行');
    }
    if (r.unresolved) {
      return this.normalizeUnresolved(check, r);
    }
    if (r.failed > 0) {
      return this.normalizeFailed(check, r);
    }
    if (r.totalTests === 0) {
      return makeAdapterResult(check, 'warning', '未发现测试用例', { totalTests: 0 });
    }
    return makeAdapterResult(check, 'passed', `全部 ${r.passed} 项测试通过 (${r.durationMs}ms)`, {
      totalTests: r.totalTests,
      passed: r.passed,
      durationMs: r.durationMs,
    });
  }

  /** 输出解析失败（unresolved）时 totalTests 为磁盘兜底的测试文件数：磁盘有测试 → 结果未知报 warning；磁盘也无测试 → 才是真正的「未发现测试用例」 */
  private normalizeUnresolved(check: CheckConfig, r: TestResult): CheckResult {
    if (r.totalTests > 0) {
      return makeAdapterResult(
        check,
        'warning',
        `测试命令输出解析失败，磁盘发现 ${r.totalTests} 个测试文件，测试结果未知`,
        { totalTests: r.totalTests, passed: r.passed, failed: r.failed, unresolved: true },
      );
    }
    return makeAdapterResult(check, 'warning', '未发现测试用例', { totalTests: 0 });
  }

  /** 有失败用例时归一化为 failed 结果 */
  private normalizeFailed(check: CheckConfig, r: TestResult): CheckResult {
    const failDetail =
      r.details.length > 0 ? `\n失败用例:\n${r.details.slice(0, 5).join('\n')}` : '';
    return makeAdapterResult(
      check,
      'failed',
      `测试 ${r.totalTests} 项: ${r.passed} 通过, ${r.failed} 失败 (${r.durationMs}ms)${failDetail}`,
      {
        totalTests: r.totalTests,
        passed: r.passed,
        failed: r.failed,
        skipped: r.skipped,
        durationMs: r.durationMs,
      },
    );
  }
}

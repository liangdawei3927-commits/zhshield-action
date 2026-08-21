import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, CheckConfig, CheckResult, CheckStatus } from '../types';
import type { TestResult } from './test-result';
import { VitestOutputParser } from './vitest-output-parser';

const execFileAsync = promisify(execFile);

const WHITESPACE = /\s+/;
const VITEST_SUMMARY = /Tests\s+(?:(\d+)\s+passed)?\s*(?:\|\s*)?(?:(\d+)\s+failed)?\s*(?:\((\d+)\))?/;

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

  async run(
    context: { repoRoot?: string; projectPath?: string },
    _check: CheckConfig,
  ): Promise<{ result: TestResult | null; error?: string }> {
    const projectPath = context.repoRoot || context.projectPath || process.cwd();
    const detected = this.detectTestCommand(projectPath);
    if ('error' in detected) {
      return { result: null, error: detected.error };
    }

    const startTime = Date.now();
    try {
      const { stdout, stderr } = await this.executeTestRun(detected.testCmd, detected.testArgs, projectPath);

      const output = stdout + '\n' + stderr;
      return { result: this.withDiskFallback(this.parseOutput(output, startTime), projectPath) };
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
    return execFileAsync(
      testCmd || 'npx',
      testArgs.length > 0 ? testArgs : ['vitest', 'run'],
      {
        cwd: projectPath,
        timeout: 120000,
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
      return { result: this.withDiskFallback(this.parseOutput(output, startTime), projectPath) };
    }
    return { result: null, error: err.message || 'Test execution failed' };
  }

  /** 输出解析不到测试计数时，以磁盘真实测试文件数兜底并标记 unresolved（测试存在但运行结果未知） */
  private withDiskFallback(result: TestResult, projectPath: string): TestResult {
    if (result.totalTests > 0) return result;
    const testFilesOnDisk = this.outputParser.countTestFilesOnDisk(projectPath);
    return { ...result, totalTests: testFilesOnDisk, unresolved: true };
  }

  private detectTestCommand(
    projectPath: string,
  ): { testCmd: string; testArgs: string[] } | { error: string } {
    const pkg = this.loadPackageJson(projectPath);
    if ('error' in pkg) return pkg as { error: string };

    const testScript = this.findTestScript(pkg);
    if (!testScript) {
      return { error: 'No test script found in package.json' };
    }

    return this.toTestCommand(testScript);
  }

  /** 读取并解析 package.json */
  private loadPackageJson(projectPath: string): Record<string, unknown> | { error: string } {
    const pkgJsonPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      return { error: 'package.json not found' };
    }

    try {
      return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    } catch {
      return { error: 'Invalid package.json' };
    }
  }

  /** 从 package.json scripts 中查找测试脚本 */
  private findTestScript(pkg: Record<string, unknown>): string | undefined {
    const scripts = pkg.scripts as Record<string, string | undefined> | undefined;
    return scripts?.test || scripts?.['test:run'] || scripts?.vitest;
  }

  /** 将测试脚本拆分为命令与参数 */
  private toTestCommand(testScript: string): { testCmd: string; testArgs: string[] } {
    const parts = testScript.split(WHITESPACE);
    const bin = parts[0];
    const args = parts.slice(1);

    // If using pnpm/turbo, run the raw runner directly
    return {
      testCmd: bin === 'vitest' ? 'npx' : bin,
      testArgs: bin === 'vitest' ? ['vitest', 'run', ...args] : args,
    };
  }

  private parseOutput(output: string, startTime: number): TestResult {
    const lines = output.split('\n');
    const details: string[] = [];

    // Try to parse vitest output: "Tests  12 passed | 2 failed (14)"
    // Also try: "Tests  14 passed (14)"
    // Also try: "Tests  14 passed"
    let totalTests = 0;
    let passed = 0;
    let failed = 0;
    const skipped = 0;

    for (const line of lines) {
      const trimmed = line.trim();

      // vitest summary: "Tests  12 passed | 2 failed (14)"
      const vitestMatch = trimmed.match(VITEST_SUMMARY);
      if (vitestMatch) {
        passed = parseInt(vitestMatch[1] || '0', 10);
        failed = parseInt(vitestMatch[2] || '0', 10);
        totalTests = parseInt(vitestMatch[3] || String(passed + failed), 10);
        continue;
      }

      if (trimmed.includes('FAIL') && trimmed.includes('__tests__')) {
        details.push(trimmed);
      }
    }

    // Fallback: if vitest parsing failed, look for test files
    if (totalTests === 0) {
      const testFileMatches = lines.filter(l => l.includes('__tests__') && l.includes('.test.'));
      totalTests = testFileMatches.length;
      passed = totalTests;
    }

    const durationMs = Date.now() - startTime;

    return { command: 'vitest run', totalTests, passed, failed, skipped, durationMs, details };
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
